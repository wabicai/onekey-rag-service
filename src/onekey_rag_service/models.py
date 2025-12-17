from __future__ import annotations

import datetime as dt
import os

from pgvector.sqlalchemy import Vector
from dotenv import load_dotenv
from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

load_dotenv()
_PGVECTOR_DIM = int(os.getenv("PGVECTOR_EMBEDDING_DIM", "768"))

DEFAULT_WORKSPACE_ID = os.getenv("DEFAULT_WORKSPACE_ID", "default")
DEFAULT_KB_ID = os.getenv("DEFAULT_KB_ID", "default")


class Base(DeclarativeBase):
    pass


class Workspace(Base):
    __tablename__ = "workspaces"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(Text, default="", nullable=False)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=dt.datetime.utcnow)


class KnowledgeBase(Base):
    __tablename__ = "knowledge_bases"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(Text, default="", nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="active", nullable=False)
    config: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=dt.datetime.utcnow)
    updated_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=dt.datetime.utcnow)


class DataSource(Base):
    __tablename__ = "data_sources"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True)
    kb_id: Mapped[str] = mapped_column(ForeignKey("knowledge_bases.id", ondelete="CASCADE"), nullable=False, index=True)
    type: Mapped[str] = mapped_column(String(32), default="crawler_site", nullable=False)
    name: Mapped[str] = mapped_column(Text, default="", nullable=False)
    config: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="active", nullable=False)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=dt.datetime.utcnow)
    updated_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=dt.datetime.utcnow)


class RagApp(Base):
    __tablename__ = "rag_apps"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(Text, default="", nullable=False)
    public_model_id: Mapped[str] = mapped_column(String(128), unique=True, nullable=False, index=True)
    status: Mapped[str] = mapped_column(String(32), default="published", nullable=False)
    config: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=dt.datetime.utcnow)
    updated_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=dt.datetime.utcnow)


class RagAppKnowledgeBase(Base):
    __tablename__ = "app_kbs"
    __table_args__ = (UniqueConstraint("app_id", "kb_id", name="uq_app_kbs_app_kb"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True)
    app_id: Mapped[str] = mapped_column(ForeignKey("rag_apps.id", ondelete="CASCADE"), nullable=False, index=True)
    kb_id: Mapped[str] = mapped_column(ForeignKey("knowledge_bases.id", ondelete="CASCADE"), nullable=False, index=True)
    priority: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    weight: Mapped[float] = mapped_column(Float, default=1.0, nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=dt.datetime.utcnow)


class RetrievalEvent(Base):
    __tablename__ = "retrieval_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    workspace_id: Mapped[str] = mapped_column(String(64), default=DEFAULT_WORKSPACE_ID, nullable=False, index=True)
    app_id: Mapped[str] = mapped_column(String(64), default="", nullable=False, index=True)
    kb_ids: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    request_id: Mapped[str] = mapped_column(String(128), default="", nullable=False, index=True)
    conversation_id: Mapped[str] = mapped_column(String(128), default="", nullable=False, index=True)
    message_id: Mapped[str] = mapped_column(String(128), default="", nullable=False, index=True)
    question_sha256: Mapped[str] = mapped_column(String(64), default="", nullable=False)
    question_len: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    retrieval_query_sha256: Mapped[str] = mapped_column(String(64), default="", nullable=False)
    retrieval_query_len: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    timings_ms: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    retrieval: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    sources: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    token_usage: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    error: Mapped[str] = mapped_column(Text, default="", nullable=False)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=dt.datetime.utcnow)


class Page(Base):
    __tablename__ = "pages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    workspace_id: Mapped[str] = mapped_column(String(64), default=DEFAULT_WORKSPACE_ID, nullable=False, index=True)
    kb_id: Mapped[str] = mapped_column(String(64), default=DEFAULT_KB_ID, nullable=False, index=True)
    source_id: Mapped[str] = mapped_column(String(64), default="", nullable=False, index=True)
    url: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    title: Mapped[str] = mapped_column(Text, default="", nullable=False)
    content_markdown: Mapped[str] = mapped_column(Text, default="", nullable=False)
    content_hash: Mapped[str] = mapped_column(String(64), default="", nullable=False)
    indexed_content_hash: Mapped[str] = mapped_column(String(64), default="", nullable=False)
    http_status: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    last_crawled_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=dt.datetime.utcnow)
    meta: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)

    chunks: Mapped[list["Chunk"]] = relationship(back_populates="page", cascade="all, delete-orphan")


class Chunk(Base):
    __tablename__ = "chunks"
    __table_args__ = (
        UniqueConstraint("page_id", "chunk_index", name="uq_chunks_page_chunk_index"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    page_id: Mapped[int] = mapped_column(ForeignKey("pages.id", ondelete="CASCADE"), nullable=False, index=True)
    chunk_index: Mapped[int] = mapped_column(Integer, nullable=False)
    section_path: Mapped[str] = mapped_column(Text, default="", nullable=False)
    chunk_text: Mapped[str] = mapped_column(Text, default="", nullable=False)
    chunk_hash: Mapped[str] = mapped_column(String(64), default="", nullable=False)
    token_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    embedding: Mapped[list[float] | None] = mapped_column(Vector(_PGVECTOR_DIM), nullable=True)
    embedding_model: Mapped[str] = mapped_column(Text, default="", nullable=False)

    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=dt.datetime.utcnow)

    page: Mapped[Page] = relationship(back_populates="chunks")


class Job(Base):
    __tablename__ = "jobs"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(String(64), default=DEFAULT_WORKSPACE_ID, nullable=False, index=True)
    kb_id: Mapped[str] = mapped_column(String(64), default=DEFAULT_KB_ID, nullable=False, index=True)
    app_id: Mapped[str] = mapped_column(String(64), default="", nullable=False, index=True)
    source_id: Mapped[str] = mapped_column(String(64), default="", nullable=False, index=True)
    type: Mapped[str] = mapped_column(String(32), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    payload: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    progress: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    error: Mapped[str] = mapped_column(Text, default="", nullable=False)
    started_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=dt.datetime.utcnow)
    finished_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Feedback(Base):
    __tablename__ = "feedback"
    __table_args__ = (
        # 企业级约束：同一 conversation/message 只保留一条反馈，避免重复插入
        UniqueConstraint("conversation_id", "message_id", name="uix_feedback_conversation_message"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    workspace_id: Mapped[str] = mapped_column(String(64), default=DEFAULT_WORKSPACE_ID, nullable=False, index=True)
    app_id: Mapped[str] = mapped_column(String(64), default="", nullable=False, index=True)
    conversation_id: Mapped[str] = mapped_column(String(128), default="", nullable=False, index=True)
    message_id: Mapped[str] = mapped_column(String(128), default="", nullable=False, index=True)
    rating: Mapped[str] = mapped_column(String(16), nullable=False)
    reason: Mapped[str] = mapped_column(String(64), default="", nullable=False)
    comment: Mapped[str] = mapped_column(Text, default="", nullable=False)
    sources: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=dt.datetime.utcnow)
