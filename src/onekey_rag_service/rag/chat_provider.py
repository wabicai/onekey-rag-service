from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, AsyncIterator
from urllib.parse import urlparse, urlunparse

from onekey_rag_service.config import Settings


@dataclass(frozen=True)
class ChatResult:
    content: str
    usage: dict[str, int] | None = None


class ChatProvider:
    async def complete(
        self, *, model: str, messages: list[dict[str, Any]], callbacks: list[Any] | None = None, **kwargs: Any
    ) -> ChatResult:
        raise NotImplementedError

    async def stream(
        self, *, model: str, messages: list[dict[str, Any]], callbacks: list[Any] | None = None, **kwargs: Any
    ) -> AsyncIterator[str]:
        result = await self.complete(model=model, messages=messages, callbacks=callbacks, **kwargs)
        yield result.content


@dataclass(frozen=True)
class LangChainInitChatProvider(ChatProvider):
    model_provider: str
    base_url: str
    api_key: str
    timeout_s: float = 60.0
    max_retries: int = 2

    def _build_model(
        self,
        *,
        model: str,
        temperature: float | None,
        top_p: float | None,
        max_tokens: int | None,
        response_format: dict[str, Any] | None,
        callbacks: list[Any] | None,
    ):
        try:
            from langchain.chat_models import init_chat_model  # type: ignore
        except Exception as e:  # pragma: no cover
            raise RuntimeError(
                "未安装 LangChain 或缺少对应的 provider 依赖；请检查 requirements.txt（例如需要 langchain-openai）"
            ) from e

        base_url = _normalize_openai_compatible_base_url(self.base_url)

        kwargs: dict[str, Any] = {
            "model": model,
            "temperature": temperature,
            "top_p": top_p,
            "timeout": self.timeout_s,
            "max_tokens": max_tokens,
            "max_retries": self.max_retries,
            "base_url": base_url,
            "api_key": self.api_key,
            "response_format": response_format,
        }
        if callbacks:
            kwargs["callbacks"] = callbacks

        if self.model_provider:
            kwargs["model_provider"] = self.model_provider

        # init_chat_model 会把 kwargs 透传给具体 provider 的 ChatModel 实现
        return init_chat_model(**{k: v for k, v in kwargs.items() if v is not None})

    async def complete(
        self,
        *,
        model: str,
        messages: list[dict[str, Any]],
        callbacks: list[Any] | None = None,
        temperature: float | None = None,
        top_p: float | None = None,
        max_tokens: int | None = None,
        response_format: dict[str, Any] | None = None,
        **_: Any,
    ) -> ChatResult:
        lc_model = self._build_model(
            model=model,
            temperature=temperature,
            top_p=top_p,
            max_tokens=max_tokens,
            response_format=response_format,
            callbacks=callbacks,
        )
        try:
            msg = await lc_model.ainvoke(messages)
        except Exception as e:
            if response_format and _maybe_response_format_error(e):
                lc_model = self._build_model(
                    model=model,
                    temperature=temperature,
                    top_p=top_p,
                    max_tokens=max_tokens,
                    response_format=None,
                    callbacks=callbacks,
                )
                msg = await lc_model.ainvoke(messages)
            else:
                raise

        content = ""
        text = getattr(msg, "text", None)
        if isinstance(text, str):
            content = text
        else:
            c = getattr(msg, "content", "")
            content = c if isinstance(c, str) else str(c)

        usage = _extract_usage(msg)
        return ChatResult(content=content, usage=usage)

    async def stream(
        self,
        *,
        model: str,
        messages: list[dict[str, Any]],
        callbacks: list[Any] | None = None,
        temperature: float | None = None,
        top_p: float | None = None,
        max_tokens: int | None = None,
        response_format: dict[str, Any] | None = None,
        **_: Any,
    ) -> AsyncIterator[str]:
        lc_model = self._build_model(
            model=model,
            temperature=temperature,
            top_p=top_p,
            max_tokens=max_tokens,
            response_format=response_format,
            callbacks=callbacks,
        )
        async for chunk in lc_model.astream(messages):
            text = _extract_chunk_text(chunk)
            if text:
                yield text


def _extract_usage(msg: Any) -> dict[str, int] | None:
    usage_meta = getattr(msg, "usage_metadata", None)
    if isinstance(usage_meta, dict):
        prompt_tokens = int(usage_meta.get("input_tokens") or usage_meta.get("prompt_tokens") or 0)
        completion_tokens = int(usage_meta.get("output_tokens") or usage_meta.get("completion_tokens") or 0)
        total_tokens = int(usage_meta.get("total_tokens") or (prompt_tokens + completion_tokens) or 0)
        return {"prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens, "total_tokens": total_tokens}

    resp_meta = getattr(msg, "response_metadata", None)
    if isinstance(resp_meta, dict):
        token_usage = resp_meta.get("token_usage")
        if isinstance(token_usage, dict):
            prompt_tokens = int(token_usage.get("prompt_tokens") or 0)
            completion_tokens = int(token_usage.get("completion_tokens") or 0)
            total_tokens = int(token_usage.get("total_tokens") or (prompt_tokens + completion_tokens) or 0)
            return {"prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens, "total_tokens": total_tokens}
    return None


def _normalize_openai_compatible_base_url(url: str) -> str:
    """
    OpenAI-compatible 服务通常要求 base_url 包含 /v1（例如 https://api.deepseek.com/v1）。
    为了容错：当用户配置为根路径（/ 或空）时，自动补齐 /v1。
    """
    try:
        parsed = urlparse(url)
    except Exception:
        return url

    path = (parsed.path or "").rstrip("/")
    if path in {"", "/"}:
        path = "/v1"
    return urlunparse(parsed._replace(path=path))


def _extract_chunk_text(chunk: Any) -> str:
    text = getattr(chunk, "text", None)
    if isinstance(text, str) and text:
        return text

    content = getattr(chunk, "content", None)
    if isinstance(content, str) and content:
        return content

    blocks = getattr(chunk, "content_blocks", None)
    if isinstance(blocks, list):
        parts: list[str] = []
        for b in blocks:
            if not isinstance(b, dict):
                continue
            if b.get("type") != "text":
                continue
            t = b.get("text")
            if isinstance(t, str) and t:
                parts.append(t)
        if parts:
            return "".join(parts)

    return ""


def _maybe_response_format_error(exc: Exception) -> bool:
    message = str(exc).lower()
    keywords = [
        "response_format",
        "json_object",
        "json mode",
        "unknown parameter",
        "invalid parameter",
    ]
    return any(k in message for k in keywords)


def build_chat_provider(settings: Settings) -> ChatProvider | None:
    provider = (settings.chat_provider or "").lower()
    if provider in {"none", "off", "disabled", "false", "0"}:
        return None
    if not settings.chat_api_key:
        return None

    # 默认使用 LangChain 官方推荐的 init_chat_model 统一初始化
    if provider in {"", "langchain", "init_chat_model", "langchain_init", "openai_compatible"}:
        return LangChainInitChatProvider(
            model_provider=settings.chat_model_provider,
            base_url=str(settings.chat_base_url),
            api_key=settings.chat_api_key,
            timeout_s=settings.chat_timeout_s,
            max_retries=settings.chat_max_retries,
        )

    raise RuntimeError(f"未知 CHAT_PROVIDER: {settings.chat_provider}")


def now_unix() -> int:
    return int(time.time())
