from __future__ import annotations

import logging

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker

from onekey_rag_service.config import Settings

logger = logging.getLogger(__name__)


def create_db_engine(settings: Settings) -> Engine:
    return create_engine(settings.database_url, pool_pre_ping=True)


def create_session_factory(engine: Engine) -> sessionmaker:
    return sessionmaker(bind=engine, autocommit=False, autoflush=False)


def ensure_pgvector_extension(engine: Engine) -> None:
    with engine.begin() as conn:
        conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))


def ensure_indexes(engine: Engine, settings: Settings) -> None:
    if not settings.auto_create_indexes:
        return

    _ensure_embedding_dimension(engine, settings)
    _ensure_pgvector_index(engine, settings)
    _ensure_fts_index(engine, settings)


def _is_safe_ident(name: str) -> bool:
    # 仅用于拼接 SQL 标识符，避免注入风险
    return bool(name) and all(ch.isalnum() or ch == "_" for ch in name)


def ensure_admin_orphan_types(engine: Engine, *, schema: str = "public") -> None:
    """
    兼容“异常中断/并发启动”场景：

    Postgres 在创建表时会同时创建同名复合类型（pg_type）。当进程在建表中途异常退出或并发启动时，
    可能出现“表不存在，但同名类型残留”的状态，导致后续 `CREATE TABLE` 报：
    `duplicate key value violates unique constraint pg_type_typname_nsp_index`。

    本函数会在“表不存在 + 类型是孤儿复合类型”时清理该类型，保证启动幂等。
    """

    if not _is_safe_ident(schema):
        raise ValueError("schema 名称不安全")

    table_names = ["workspaces", "knowledge_bases", "data_sources", "rag_apps", "app_kbs", "retrieval_events"]
    for t in table_names:
        if not _is_safe_ident(t):
            raise ValueError("表名不安全")

    with engine.begin() as conn:
        for t in table_names:
            try:
                rel = conn.execute(text("SELECT to_regclass(:name)"), {"name": f"{schema}.{t}"}).scalar()
            except Exception as e:
                logger.warning("检查表是否存在失败 table=%s.%s err=%s", schema, t, e)
                continue
            if rel:
                continue

            row = conn.execute(
                text(
                    """
                    SELECT t.typtype, c.oid
                    FROM pg_type t
                    JOIN pg_namespace n ON n.oid = t.typnamespace
                    LEFT JOIN pg_class c ON c.oid = t.typrelid
                    WHERE n.nspname = :schema
                      AND t.typname = :typname
                    LIMIT 1
                    """
                ),
                {"schema": schema, "typname": t},
            ).first()
            if not row:
                continue

            typtype = str(row[0] or "")
            rel_oid = row[1]
            if typtype != "c" or rel_oid is not None:
                continue

            try:
                conn.execute(text(f"DROP TYPE IF EXISTS {schema}.{t} CASCADE"))
                logger.warning("已清理孤儿复合类型：%s.%s", schema, t)
            except Exception as e:
                logger.warning("清理孤儿类型失败 type=%s.%s err=%s", schema, t, e)


def create_all_safe(engine: Engine, metadata) -> None:
    """
    `metadata.create_all` 的安全包装：
    - 先清理可能残留的孤儿类型（见 ensure_admin_orphan_types）
    - 遇到 pg_type 唯一约束冲突时，清理后重试一次
    """

    ensure_admin_orphan_types(engine)
    try:
        metadata.create_all(engine)
        return
    except IntegrityError as e:
        if "pg_type_typname_nsp_index" not in str(e):
            raise

    # 并发/异常中断时可能出现 catalog 竞争：清理后重试一次
    ensure_admin_orphan_types(engine)
    metadata.create_all(engine)


def ensure_admin_schema(engine: Engine) -> None:
    """
    轻量级“迁移”：在不引入 Alembic 的前提下，为历史库补齐 Admin 所需字段与索引。

    约束：
    - 只做“加字段/加索引”，不做破坏性变更（不删列、不改约束）。
    - 使用 IF NOT EXISTS，保证多次启动幂等。
    """

    with engine.begin() as conn:
        # pages：workspace/kb/source 维度（当前阶段以 workspace 为隔离边界）
        try:
            conn.execute(text("ALTER TABLE pages ADD COLUMN IF NOT EXISTS workspace_id varchar(64) NOT NULL DEFAULT 'default'"))
            conn.execute(text("ALTER TABLE pages ADD COLUMN IF NOT EXISTS kb_id varchar(64) NOT NULL DEFAULT 'default'"))
            conn.execute(text("ALTER TABLE pages ADD COLUMN IF NOT EXISTS source_id varchar(64) NOT NULL DEFAULT ''"))

            conn.execute(text("CREATE INDEX IF NOT EXISTS idx_pages_workspace_id ON pages (workspace_id)"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS idx_pages_kb_id ON pages (kb_id)"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS idx_pages_source_id ON pages (source_id)"))
        except Exception as e:
            logger.warning("确保 pages 多租户字段失败：%s", e)

        # jobs：增加 scope 字段用于筛选与审计
        try:
            conn.execute(text("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS workspace_id varchar(64) NOT NULL DEFAULT 'default'"))
            conn.execute(text("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS kb_id varchar(64) NOT NULL DEFAULT 'default'"))
            conn.execute(text("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS app_id varchar(64) NOT NULL DEFAULT ''"))
            conn.execute(text("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source_id varchar(64) NOT NULL DEFAULT ''"))
            # 若历史库已存在列，确保默认值符合当前约定
            conn.execute(text("ALTER TABLE jobs ALTER COLUMN kb_id SET DEFAULT 'default'"))

            conn.execute(text("CREATE INDEX IF NOT EXISTS idx_jobs_workspace_id ON jobs (workspace_id)"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS idx_jobs_type_status ON jobs (type, status)"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS idx_jobs_kb_id ON jobs (kb_id)"))
        except Exception as e:
            logger.warning("确保 jobs 多租户字段失败：%s", e)

        # feedback：增加 workspace/app 维度
        try:
            conn.execute(text("ALTER TABLE feedback ADD COLUMN IF NOT EXISTS workspace_id varchar(64) NOT NULL DEFAULT 'default'"))
            conn.execute(text("ALTER TABLE feedback ADD COLUMN IF NOT EXISTS app_id varchar(64) NOT NULL DEFAULT ''"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS idx_feedback_workspace_id ON feedback (workspace_id)"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS idx_feedback_app_id ON feedback (app_id)"))
        except Exception as e:
            logger.warning("确保 feedback 多租户字段失败：%s", e)

def _ensure_embedding_dimension(engine: Engine, settings: Settings) -> None:
    """
    兼容历史库：早期 embedding 列可能是 vector（无维度）。
    pgvector 的 HNSW/IVFFLAT 索引要求列类型带维度（vector(n)）。
    """

    with engine.begin() as conn:
        try:
            row = conn.execute(
                text(
                    """
                    SELECT format_type(a.atttypid, a.atttypmod) AS t
                    FROM pg_attribute a
                    JOIN pg_class c ON c.oid = a.attrelid
                    JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE c.relname = 'chunks'
                      AND a.attname = 'embedding'
                      AND a.attnum > 0
                      AND NOT a.attisdropped
                    LIMIT 1
                    """
                )
            ).first()
            col_type = str(row[0]) if row and row[0] else ""
        except Exception as e:
            logger.warning("读取 chunks.embedding 列类型失败：%s", e)
            return

        dim = int(settings.pgvector_embedding_dim)

        # 仅在“无维度 vector”时自动修复
        if col_type == "vector":
            try:
                conn.execute(
                    text(
                        f"""
                        ALTER TABLE chunks
                        ALTER COLUMN embedding
                        TYPE vector({dim})
                        USING embedding::vector({dim})
                        """
                    )
                )
                logger.info("已自动修复 chunks.embedding 为 vector(%s)", dim)
            except Exception as e:
                logger.warning(
                    "自动修复 chunks.embedding 维度失败（可能需要清空并重建向量列/重建 pgdata）：%s",
                    e,
                )
        elif col_type.startswith("vector(") and col_type.endswith(")"):
            # 若维度不一致，提醒用户重建索引/重建数据
            try:
                current_dim = int(col_type[len("vector(") : -1])
                if current_dim != dim:
                    logger.warning(
                        "当前库 chunks.embedding=%s 与 PGVECTOR_EMBEDDING_DIM=%s 不一致；请重建向量数据/重建 pgdata 以避免检索异常",
                        col_type,
                        dim,
                    )
            except Exception:
                pass


def _ensure_pgvector_index(engine: Engine, settings: Settings) -> None:
    index_type = (settings.pgvector_index_type or "none").lower()
    if index_type in {"none", "off", "false", "0"}:
        return

    with engine.begin() as conn:
        try:
            if index_type == "hnsw":
                conn.execute(
                    text(
                        """
                        CREATE INDEX IF NOT EXISTS idx_chunks_embedding_hnsw
                        ON chunks
                        USING hnsw (embedding vector_cosine_ops)
                        WITH (m = :m, ef_construction = :efc)
                        """
                    ),
                    {"m": int(settings.pgvector_hnsw_m), "efc": int(settings.pgvector_hnsw_ef_construction)},
                )
            elif index_type == "ivfflat":
                conn.execute(
                    text(
                        """
                        CREATE INDEX IF NOT EXISTS idx_chunks_embedding_ivfflat
                        ON chunks
                        USING ivfflat (embedding vector_cosine_ops)
                        WITH (lists = :lists)
                        """
                    ),
                    {"lists": int(settings.pgvector_ivfflat_lists)},
                )
            else:
                logger.warning("未知 PGVECTOR_INDEX_TYPE=%s，已跳过建索引", settings.pgvector_index_type)
        except Exception as e:
            logger.warning("创建 pgvector 索引失败：%s", e)


def _ensure_fts_index(engine: Engine, settings: Settings) -> None:
    if (settings.retrieval_mode or "").lower() != "hybrid":
        return

    raw_cfg = (settings.bm25_fts_config or "simple").strip() or "simple"
    cfg = raw_cfg if all(ch.isalnum() or ch == "_" for ch in raw_cfg) else "simple"
    idx_name = f"idx_chunks_fts_{cfg.lower()}"

    with engine.begin() as conn:
        try:
            conn.execute(
                text(
                    f"""
                    CREATE INDEX IF NOT EXISTS {idx_name}
                    ON chunks
                    USING gin (to_tsvector('{cfg}', chunk_text))
                    """
                )
            )
        except Exception as e:
            logger.warning("创建 FTS(GIN) 索引失败：%s", e)
