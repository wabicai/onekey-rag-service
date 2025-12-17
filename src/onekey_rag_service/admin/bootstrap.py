from __future__ import annotations

import datetime as dt

from sqlalchemy import select
from sqlalchemy.orm import Session

from onekey_rag_service.config import Settings
from onekey_rag_service.models import (
    DEFAULT_KB_ID,
    DEFAULT_WORKSPACE_ID,
    DataSource,
    KnowledgeBase,
    RagApp,
    RagAppKnowledgeBase,
    Workspace,
)


def ensure_default_entities(session: Session, *, settings: Settings) -> None:
    """
    启动时确保存在“默认工作区/默认 KB/默认 App”，用于：
    - 单机单租户快速跑通链路
    - 兼容旧接口（未传 workspace/kb/app）
    """

    now = dt.datetime.utcnow()

    # 不依赖 ORM relationship 的插入顺序：显式 flush，避免外键约束下出现“子表先插入”的问题
    with session.no_autoflush:
        ws = session.get(Workspace, DEFAULT_WORKSPACE_ID)
        if not ws:
            ws = Workspace(id=DEFAULT_WORKSPACE_ID, name="默认工作区", created_at=now)
            session.add(ws)
            session.flush()

        kb = session.get(KnowledgeBase, DEFAULT_KB_ID)
        if not kb:
            kb = KnowledgeBase(
                id=DEFAULT_KB_ID,
                workspace_id=DEFAULT_WORKSPACE_ID,
                name="默认知识库",
                description="系统自动创建的默认知识库",
                status="active",
                config={},
                created_at=now,
                updated_at=now,
            )
            session.add(kb)
            session.flush()

        # 默认数据源（crawler）
        default_source_id = "source_default"
        ds = session.get(DataSource, default_source_id)
        if not ds:
            ds = DataSource(
                id=default_source_id,
                workspace_id=DEFAULT_WORKSPACE_ID,
                kb_id=DEFAULT_KB_ID,
                type="crawler_site",
                name="默认爬虫源",
                config={
                    "base_url": str(settings.crawl_base_url),
                    "sitemap_url": str(settings.crawl_sitemap_url),
                    "seed_urls": [str(settings.crawl_base_url)],
                    "include_patterns": [],
                    "exclude_patterns": [],
                    "max_pages": int(settings.crawl_max_pages),
                },
                status="active",
                created_at=now,
                updated_at=now,
            )
            session.add(ds)
            session.flush()

        # 默认 App：对外 model_id 与现有服务保持一致
        default_app_id = "app_default"
        app = session.get(RagApp, default_app_id)
        if not app:
            app = RagApp(
                id=default_app_id,
                workspace_id=DEFAULT_WORKSPACE_ID,
                name="默认 RagApp",
                public_model_id="onekey-docs",
                status="published",
                config={},
                created_at=now,
                updated_at=now,
            )
            session.add(app)
            session.flush()

        # 默认绑定：App -> 默认 KB（weight=1, priority=0）
        exists = session.execute(
            select(RagAppKnowledgeBase).where(
                RagAppKnowledgeBase.app_id == default_app_id,
                RagAppKnowledgeBase.kb_id == DEFAULT_KB_ID,
            )
        ).scalar_one_or_none()
        if not exists:
            session.add(
                RagAppKnowledgeBase(
                    workspace_id=DEFAULT_WORKSPACE_ID,
                    app_id=default_app_id,
                    kb_id=DEFAULT_KB_ID,
                    priority=0,
                    weight=1.0,
                    enabled=True,
                    created_at=now,
                )
            )

    session.commit()
