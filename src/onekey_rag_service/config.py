from __future__ import annotations

import json

from pydantic import AnyUrl, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_env: str = Field(default="local", alias="APP_ENV")
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")

    database_url: str = Field(alias="DATABASE_URL")
    pgvector_embedding_dim: int = Field(default=768, alias="PGVECTOR_EMBEDDING_DIM")

    crawl_base_url: AnyUrl = Field(default="https://developer.onekey.so/", alias="CRAWL_BASE_URL")
    crawl_sitemap_url: AnyUrl = Field(default="https://developer.onekey.so/sitemap.xml", alias="CRAWL_SITEMAP_URL")
    crawl_max_pages: int = Field(default=2000, alias="CRAWL_MAX_PAGES")

    chunk_max_chars: int = Field(default=2400, alias="CHUNK_MAX_CHARS")
    chunk_overlap_chars: int = Field(default=200, alias="CHUNK_OVERLAP_CHARS")

    rag_top_k: int = Field(default=30, alias="RAG_TOP_K")
    rag_top_n: int = Field(default=8, alias="RAG_TOP_N")
    # 返回 sources 时的最大条数；默认改为 3，避免前端展示过多引用
    rag_max_sources: int = Field(default=3, alias="RAG_MAX_SOURCES")
    rag_context_max_chars: int = Field(default=12_000, alias="RAG_CONTEXT_MAX_CHARS")
    rag_snippet_max_chars: int = Field(default=360, alias="RAG_SNIPPET_MAX_CHARS")
    rag_prepare_timeout_s: float = Field(default=25.0, alias="RAG_PREPARE_TIMEOUT_S")
    rag_total_timeout_s: float = Field(default=120.0, alias="RAG_TOTAL_TIMEOUT_S")
    max_concurrent_chat_requests: int = Field(default=12, alias="MAX_CONCURRENT_CHAT_REQUESTS")

    # Query embedding 缓存（提高 QPS/降低 CPU；多实例下为“每实例缓存”）
    query_embed_cache_size: int = Field(default=512, alias="QUERY_EMBED_CACHE_SIZE")
    query_embed_cache_ttl_s: float = Field(default=600.0, alias="QUERY_EMBED_CACHE_TTL_S")

    # 检索策略：vector / hybrid（BM25+向量）
    retrieval_mode: str = Field(default="hybrid", alias="RETRIEVAL_MODE")
    hybrid_vector_k: int = Field(default=30, alias="HYBRID_VECTOR_K")
    hybrid_bm25_k: int = Field(default=30, alias="HYBRID_BM25_K")
    hybrid_vector_weight: float = Field(default=0.7, alias="HYBRID_VECTOR_WEIGHT")
    hybrid_bm25_weight: float = Field(default=0.3, alias="HYBRID_BM25_WEIGHT")
    bm25_fts_config: str = Field(default="simple", alias="BM25_FTS_CONFIG")

    # 启动时自动创建索引（MVP 默认开启；数据规模很大时可关闭并改用手动建索引/离线建索引）
    auto_create_indexes: bool = Field(default=True, alias="AUTO_CREATE_INDEXES")
    pgvector_index_type: str = Field(default="hnsw", alias="PGVECTOR_INDEX_TYPE")  # none / hnsw / ivfflat
    pgvector_hnsw_m: int = Field(default=16, alias="PGVECTOR_HNSW_M")
    pgvector_hnsw_ef_construction: int = Field(default=64, alias="PGVECTOR_HNSW_EF_CONSTRUCTION")
    pgvector_ivfflat_lists: int = Field(default=100, alias="PGVECTOR_IVFFLAT_LISTS")

    embeddings_provider: str = Field(default="fake", alias="EMBEDDINGS_PROVIDER")
    sentence_transformers_model: str | None = Field(default=None, alias="SENTENCE_TRANSFORMERS_MODEL")

    ollama_base_url: AnyUrl = Field(default="http://localhost:11434", alias="OLLAMA_BASE_URL")
    ollama_embedding_model: str = Field(default="nomic-embed-text", alias="OLLAMA_EMBEDDING_MODEL")

    rerank_provider: str = Field(default="none", alias="RERANK_PROVIDER")
    bge_reranker_model: str = Field(default="BAAI/bge-reranker-large", alias="BGE_RERANKER_MODEL")
    rerank_device: str = Field(default="cpu", alias="RERANK_DEVICE")
    rerank_batch_size: int = Field(default=16, alias="RERANK_BATCH_SIZE")
    rerank_max_candidates: int = Field(default=30, alias="RERANK_MAX_CANDIDATES")
    rerank_max_chars: int = Field(default=1200, alias="RERANK_MAX_CHARS")

    # Chat 调用方式：默认使用 LangChain 官方推荐的 init_chat_model
    chat_provider: str = Field(default="langchain", alias="CHAT_PROVIDER")
    # init_chat_model 的 provider 名称（通常 openai 即可覆盖 OpenAI-Compatible：DeepSeek/Together/vLLM/自建网关等）
    chat_model_provider: str = Field(default="openai", alias="CHAT_MODEL_PROVIDER")
    chat_base_url: AnyUrl = Field(default="https://api.openai.com/v1", alias="CHAT_BASE_URL")
    chat_api_key: str | None = Field(default=None, alias="CHAT_API_KEY")
    chat_model: str = Field(default="gpt-4o-mini", alias="CHAT_MODEL")
    chat_timeout_s: float = Field(default=60.0, alias="CHAT_TIMEOUT_S")
    chat_max_retries: int = Field(default=2, alias="CHAT_MAX_RETRIES")

    chat_default_temperature: float = Field(default=0.2, alias="CHAT_DEFAULT_TEMPERATURE")
    chat_default_top_p: float = Field(default=1.0, alias="CHAT_DEFAULT_TOP_P")
    chat_default_max_tokens: int = Field(default=1024, alias="CHAT_DEFAULT_MAX_TOKENS")

    chat_model_map_json: str | None = Field(default=None, alias="CHAT_MODEL_MAP_JSON")
    chat_model_passthrough: bool = Field(default=False, alias="CHAT_MODEL_PASSTHROUGH")

    # ========== 多轮对话：Query Rewrite / 记忆压缩 ==========
    query_rewrite_enabled: bool = Field(default=True, alias="QUERY_REWRITE_ENABLED")
    memory_summary_enabled: bool = Field(default=True, alias="MEMORY_SUMMARY_ENABLED")
    conversation_compaction_max_tokens: int = Field(default=384, alias="CONVERSATION_COMPACTION_MAX_TOKENS")
    conversation_history_max_messages: int = Field(default=12, alias="CONVERSATION_HISTORY_MAX_MESSAGES")
    conversation_history_max_chars: int = Field(default=6000, alias="CONVERSATION_HISTORY_MAX_CHARS")

    # ========== 引用格式 ==========
    inline_citations_enabled: bool = Field(default=True, alias="INLINE_CITATIONS_ENABLED")
    answer_append_sources: bool = Field(default=False, alias="ANSWER_APPEND_SOURCES")

    # ========== 任务队列（抓取/索引）==========
    # background：FastAPI BackgroundTasks（MVP，进程内，不可恢复，可能影响对话延迟）
    # worker：使用 jobs 表做持久化队列，由独立 Worker 消费（推荐）
    jobs_backend: str = Field(default="worker", alias="JOBS_BACKEND")

    # ========== Widget（前端 iframe）==========
    # 为空表示不额外下发 frame-ancestors 限制；生产建议配置为："'self' https://developer.onekey.so"
    widget_frame_ancestors: str = Field(default="", alias="WIDGET_FRAME_ANCESTORS")

    # ========== Admin（企业后台）==========
    admin_username: str = Field(default="admin", alias="ADMIN_USERNAME")
    admin_password: str = Field(default="", alias="ADMIN_PASSWORD")
    admin_jwt_secret: str = Field(default="dev-secret-change-me", alias="ADMIN_JWT_SECRET")
    admin_jwt_expires_s: int = Field(default=3600, alias="ADMIN_JWT_EXPIRES_S")

    # ========== Observability（仅存检索元数据）==========
    retrieval_events_enabled: bool = Field(default=True, alias="RETRIEVAL_EVENTS_ENABLED")

    # ========== Pricing（可选，用于成本估算）==========
    # JSON 格式示例：
    # {"gpt-4o-mini":{"prompt_usd_per_1k":0.00015,"completion_usd_per_1k":0.0006}}
    pricing_json: str | None = Field(default=None, alias="MODEL_PRICING_JSON")

    def chat_model_map(self) -> dict[str, str]:
        if not self.chat_model_map_json:
            return {}
        try:
            data = json.loads(self.chat_model_map_json)
        except Exception as e:
            raise RuntimeError("CHAT_MODEL_MAP_JSON 不是合法 JSON") from e
        if not isinstance(data, dict):
            raise RuntimeError("CHAT_MODEL_MAP_JSON 需要是 JSON 对象（dict）")

        result: dict[str, str] = {}
        for k, v in data.items():
            if not isinstance(k, str) or not isinstance(v, str):
                continue
            if not k.strip() or not v.strip():
                continue
            result[k.strip()] = v.strip()
        return result

    def model_pricing(self) -> dict[str, dict[str, float]]:
        """
        返回模型计价配置，用于 Admin 的成本估算（非强一致，主要用于内部观测）。

        格式：{model: {prompt_usd_per_1k: float, completion_usd_per_1k: float}}
        """

        if not self.pricing_json:
            return {}
        try:
            data = json.loads(self.pricing_json)
        except Exception as e:
            raise RuntimeError("MODEL_PRICING_JSON 不是合法 JSON") from e
        if not isinstance(data, dict):
            raise RuntimeError("MODEL_PRICING_JSON 需要是 JSON 对象（dict）")

        result: dict[str, dict[str, float]] = {}
        for k, v in data.items():
            if not isinstance(k, str) or not k.strip():
                continue
            if not isinstance(v, dict):
                continue
            prompt = v.get("prompt_usd_per_1k")
            completion = v.get("completion_usd_per_1k")
            if not isinstance(prompt, (int, float)) or not isinstance(completion, (int, float)):
                continue
            result[k.strip()] = {"prompt_usd_per_1k": float(prompt), "completion_usd_per_1k": float(completion)}
        return result


def get_settings() -> Settings:
    return Settings()
