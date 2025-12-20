from __future__ import annotations

import collections
import hashlib
import math
import threading
import time
from dataclasses import dataclass
from typing import Callable

import httpx

from onekey_rag_service.config import Settings


class EmbeddingsProvider:
    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        raise NotImplementedError

    def embed_query(self, text: str) -> list[float]:
        return self.embed_documents([text])[0]


class LazyEmbeddingsProvider(EmbeddingsProvider):
    def __init__(self, factory: Callable[[], EmbeddingsProvider], name: str) -> None:
        self._factory = factory
        self._name = name
        self._inner: EmbeddingsProvider | None = None
        self._lock = threading.Lock()

    def _get_inner(self) -> EmbeddingsProvider:
        if self._inner is not None:
            return self._inner
        with self._lock:
            if self._inner is None:
                self._inner = self._factory()
        return self._inner

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return self._get_inner().embed_documents(texts)

    def embed_query(self, text: str) -> list[float]:
        return self._get_inner().embed_query(text)


@dataclass(frozen=True)
class CachedEmbeddingsProvider(EmbeddingsProvider):
    inner: EmbeddingsProvider
    max_size: int = 512
    ttl_s: float = 600.0

    def __post_init__(self) -> None:
        object.__setattr__(self, "_cache", collections.OrderedDict())
        object.__setattr__(self, "_lock", threading.Lock())

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return self.inner.embed_documents(texts)

    def embed_query(self, text: str) -> list[float]:
        if self.max_size <= 0:
            return self.inner.embed_query(text)

        key = hashlib.sha256(text.encode("utf-8")).hexdigest()
        now = time.time()
        with self._lock:
            item = self._cache.get(key)
            if item:
                ts, vec = item
                if self.ttl_s <= 0 or (now - ts) <= self.ttl_s:
                    self._cache.move_to_end(key)
                    return vec
                self._cache.pop(key, None)

        vec = self.inner.embed_query(text)
        with self._lock:
            self._cache[key] = (now, vec)
            self._cache.move_to_end(key)
            while len(self._cache) > self.max_size:
                self._cache.popitem(last=False)
        return vec


@dataclass(frozen=True)
class FakeEmbeddings(EmbeddingsProvider):
    dim: int

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return [_fake_embed(t, self.dim) for t in texts]


def _fake_embed(text: str, dim: int) -> list[float]:
    # 说明：用于“无模型/无网络”的开发环境，确保链路可跑通；不适用于生产检索效果要求。
    digest = hashlib.sha256(text.encode("utf-8")).digest()
    nums = list(digest) * ((dim + len(digest) - 1) // len(digest))
    vec = [((n / 255.0) * 2 - 1) for n in nums[:dim]]
    return _l2_normalize(vec)


def _l2_normalize(vec: list[float]) -> list[float]:
    norm = math.sqrt(sum(v * v for v in vec)) or 1.0
    return [v / norm for v in vec]


@dataclass(frozen=True)
class SentenceTransformersEmbeddings(EmbeddingsProvider):
    model_name_or_path: str

    def __post_init__(self) -> None:
        try:
            from sentence_transformers import SentenceTransformer  # type: ignore
        except Exception as e:  # pragma: no cover
            raise RuntimeError("未安装 sentence-transformers，请先安装或切换 EMBEDDINGS_PROVIDER") from e

        object.__setattr__(self, "_model", SentenceTransformer(self.model_name_or_path))

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        vectors = self._model.encode(texts, normalize_embeddings=True, show_progress_bar=False)
        return [v.tolist() for v in vectors]


@dataclass(frozen=True)
class OpenAICompatibleEmbeddings(EmbeddingsProvider):
    base_url: str
    api_key: str
    model: str
    timeout_s: float = 30.0

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        url = f"{self.base_url.rstrip('/')}/embeddings"
        headers = {"Authorization": f"Bearer {self.api_key}"}
        payload = {"model": self.model, "input": texts}

        resp = httpx.post(url, headers=headers, json=payload, timeout=self.timeout_s)
        resp.raise_for_status()
        data = resp.json()
        return [d["embedding"] for d in data["data"]]


@dataclass(frozen=True)
class OllamaEmbeddings(EmbeddingsProvider):
    base_url: str
    model: str
    timeout_s: float = 60.0

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []

        base = self.base_url.rstrip("/")

        with httpx.Client(timeout=self.timeout_s) as client:
            # 优先尝试 /api/embed（较新版本支持批量 input）
            try:
                resp = client.post(f"{base}/api/embed", json={"model": self.model, "input": texts})
                if resp.status_code < 400:
                    data = resp.json()
                    if isinstance(data.get("embeddings"), list):
                        return data["embeddings"]
                    if isinstance(data.get("embedding"), list) and len(texts) == 1:
                        return [data["embedding"]]
            except Exception:
                pass

            # 回退到 /api/embeddings（多数版本支持，通常为单条 prompt）
            vectors: list[list[float]] = []
            for t in texts:
                r = client.post(f"{base}/api/embeddings", json={"model": self.model, "prompt": t})
                r.raise_for_status()
                data = r.json()
                emb = data.get("embedding")
                if not isinstance(emb, list):
                    raise RuntimeError("Ollama embeddings 响应缺少 embedding 字段")
                vectors.append(emb)
            return vectors


def build_embeddings_provider(settings: Settings, *, lazy: bool = False) -> tuple[EmbeddingsProvider, str]:
    if lazy:
        name = _resolve_embeddings_name(settings)
        provider = LazyEmbeddingsProvider(lambda: _build_embeddings_provider(settings)[0], name)
        return provider, name
    return _build_embeddings_provider(settings)


def _build_embeddings_provider(settings: Settings) -> tuple[EmbeddingsProvider, str]:
    provider = settings.embeddings_provider.lower()

    if provider == "fake":
        base: EmbeddingsProvider = FakeEmbeddings(dim=settings.pgvector_embedding_dim)
        name = f"fake:{settings.pgvector_embedding_dim}"
        return _wrap_with_cache(base, name, settings=settings)

    if provider == "sentence_transformers":
        if not settings.sentence_transformers_model:
            raise RuntimeError("EMBEDDINGS_PROVIDER=sentence_transformers 需要配置 SENTENCE_TRANSFORMERS_MODEL")
        base = SentenceTransformersEmbeddings(settings.sentence_transformers_model)
        return _wrap_with_cache(base, settings.sentence_transformers_model, settings=settings)

    if provider == "ollama":
        base = OllamaEmbeddings(base_url=str(settings.ollama_base_url), model=settings.ollama_embedding_model)
        return _wrap_with_cache(base, f"ollama:{settings.ollama_embedding_model}", settings=settings)

    if provider == "openai_compatible":
        if not settings.chat_api_key:
            raise RuntimeError("EMBEDDINGS_PROVIDER=openai_compatible 需要配置 CHAT_API_KEY（或另行扩展 embedding key）")
        base = OpenAICompatibleEmbeddings(
            base_url=str(settings.chat_base_url),
            api_key=settings.chat_api_key,
            model="text-embedding-3-small",
        )
        return _wrap_with_cache(base, "openai_compatible:text-embedding-3-small", settings=settings)

    raise RuntimeError(f"未知 EMBEDDINGS_PROVIDER: {settings.embeddings_provider}")


def _resolve_embeddings_name(settings: Settings) -> str:
    provider = settings.embeddings_provider.lower()

    if provider == "fake":
        return f"fake:{settings.pgvector_embedding_dim}"

    if provider == "sentence_transformers":
        if not settings.sentence_transformers_model:
            raise RuntimeError("EMBEDDINGS_PROVIDER=sentence_transformers 需要配置 SENTENCE_TRANSFORMERS_MODEL")
        return settings.sentence_transformers_model

    if provider == "ollama":
        return f"ollama:{settings.ollama_embedding_model}"

    if provider == "openai_compatible":
        if not settings.chat_api_key:
            raise RuntimeError("EMBEDDINGS_PROVIDER=openai_compatible 需要配置 CHAT_API_KEY（或另行扩展 embedding key）")
        return "openai_compatible:text-embedding-3-small"

    raise RuntimeError(f"未知 EMBEDDINGS_PROVIDER: {settings.embeddings_provider}")


def _wrap_with_cache(base: EmbeddingsProvider, name: str, *, settings: Settings) -> tuple[EmbeddingsProvider, str]:
    if settings.query_embed_cache_size <= 0:
        return base, name
    cached = CachedEmbeddingsProvider(
        inner=base,
        max_size=settings.query_embed_cache_size,
        ttl_s=settings.query_embed_cache_ttl_s,
    )
    return cached, name
