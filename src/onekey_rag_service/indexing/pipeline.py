from __future__ import annotations

import logging

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from onekey_rag_service.indexing.chunking import chunk_markdown_by_headers
from onekey_rag_service.models import Chunk, Page
from onekey_rag_service.rag.embeddings import EmbeddingsProvider
from onekey_rag_service.utils import sha256_text

logger = logging.getLogger(__name__)


def index_pages_to_chunks(
    session: Session,
    *,
    embeddings: EmbeddingsProvider,
    embedding_model_name: str,
    workspace_id: str = "default",
    kb_id: str = "default",
    chunk_max_chars: int = 2400,
    chunk_overlap_chars: int = 200,
    mode: str = "incremental",
) -> dict[str, int]:
    pages = (
        session.scalars(
            select(Page)
            .where(Page.workspace_id == workspace_id)
            .where(Page.kb_id == kb_id)
            .where(Page.http_status < 400)
        ).all()
    )

    indexed_pages = 0
    total_chunks = 0

    for page in pages:
        if mode == "incremental":
            if page.indexed_content_hash and page.indexed_content_hash == page.content_hash:
                continue

        chunks_count = _rebuild_page_chunks(
            session,
            page,
            embeddings=embeddings,
            embedding_model_name=embedding_model_name,
            chunk_max_chars=chunk_max_chars,
            chunk_overlap_chars=chunk_overlap_chars,
        )
        page.indexed_content_hash = page.content_hash
        indexed_pages += 1
        total_chunks += chunks_count

    session.commit()
    return {"pages": indexed_pages, "chunks": total_chunks}

def _rebuild_page_chunks(
    session: Session,
    page: Page,
    *,
    embeddings: EmbeddingsProvider,
    embedding_model_name: str,
    chunk_max_chars: int,
    chunk_overlap_chars: int,
) -> int:
    session.execute(delete(Chunk).where(Chunk.page_id == page.id))
    session.flush()

    chunk_items = chunk_markdown_by_headers(
        page.content_markdown,
        max_chars=chunk_max_chars,
        overlap_chars=chunk_overlap_chars,
    )
    if not chunk_items:
        return 0

    texts = [ci.text for ci in chunk_items]
    vectors = embeddings.embed_documents(texts)

    inserted = 0
    for idx, (ci, vec) in enumerate(zip(chunk_items, vectors, strict=False)):
        chunk = Chunk(
            page_id=page.id,
            chunk_index=idx,
            section_path=ci.section_path,
            chunk_text=ci.text,
            chunk_hash=sha256_text(ci.text),
            token_count=_approx_token_count(ci.text),
            embedding=vec,
            embedding_model=embedding_model_name,
        )
        session.add(chunk)
        inserted += 1

    return inserted


def _approx_token_count(text: str) -> int:
    # MVP：不引入额外依赖时，使用粗略估计；后续可改用 tiktoken 或 tokenizer
    return max(1, len(text) // 4)
