from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from onekey_rag_service.models import Chunk, Page


@dataclass(frozen=True)
class RetrievedChunk:
    chunk_id: int
    url: str
    title: str
    section_path: str
    text: str
    score: float


def similarity_search(
    session: Session,
    *,
    query_embedding: list[float],
    workspace_id: str | None = None,
    kb_id: str | None = None,
    k: int = 30,
) -> list[RetrievedChunk]:
    distance = Chunk.embedding.cosine_distance(query_embedding)
    stmt = (
        select(
            Chunk.id,
            Page.url,
            Page.title,
            Chunk.section_path,
            Chunk.chunk_text,
            (1.0 - distance).label("score"),
        )
        .join(Page, Page.id == Chunk.page_id)
        .where(Chunk.embedding.is_not(None))
    )
    if workspace_id:
        stmt = stmt.where(Page.workspace_id == workspace_id)
    if kb_id:
        stmt = stmt.where(Page.kb_id == kb_id)
    stmt = stmt.order_by(distance.asc()).limit(k)

    rows = session.execute(stmt).all()
    return [
        RetrievedChunk(
            chunk_id=r[0],
            url=r[1],
            title=r[2] or "",
            section_path=r[3] or "",
            text=r[4] or "",
            score=float(r[5] or 0.0),
        )
        for r in rows
    ]


def bm25_search(
    session: Session,
    *,
    query: str,
    workspace_id: str | None = None,
    kb_id: str | None = None,
    k: int = 30,
    fts_config: str = "simple",
) -> list[RetrievedChunk]:
    query = (query or "").strip()
    if not query:
        return []

    raw_cfg = (fts_config or "simple").strip() or "simple"
    cfg = raw_cfg if all(ch.isalnum() or ch == "_" for ch in raw_cfg) else "simple"

    # MVP：用 Postgres FTS 的 ts_rank_cd 近似 BM25/TF-IDF 排序（无需额外依赖）。
    # 注意：fts_config 与索引表达式必须一致才能命中 GIN 索引。
    # 说明：为了让 Postgres 命中表达式 GIN 索引，fts config 需要是常量字符串（不能是 bind param）。
    extra_where = ""
    params: dict[str, object] = {"q": query, "k": k}
    if workspace_id:
        extra_where += " AND p.workspace_id = :ws"
        params["ws"] = workspace_id
    if kb_id:
        extra_where += " AND p.kb_id = :kb"
        params["kb"] = kb_id

    stmt = text(
        f"""
        WITH q AS (
          SELECT plainto_tsquery('{cfg}', :q) AS query
        )
        SELECT
          c.id AS chunk_id,
          p.url AS url,
          p.title AS title,
          c.section_path AS section_path,
          c.chunk_text AS text,
          ts_rank_cd(to_tsvector('{cfg}', c.chunk_text), q.query) AS score
        FROM chunks c
        JOIN pages p ON p.id = c.page_id
        JOIN q ON TRUE
        WHERE c.chunk_text <> ''
          AND to_tsvector('{cfg}', c.chunk_text) @@ q.query
          {extra_where}
        ORDER BY score DESC
        LIMIT :k
        """
    )

    try:
        rows = session.execute(stmt, params).all()
    except Exception:
        return []
    return [
        RetrievedChunk(
            chunk_id=int(r[0]),
            url=str(r[1]),
            title=str(r[2] or ""),
            section_path=str(r[3] or ""),
            text=str(r[4] or ""),
            score=float(r[5] or 0.0),
        )
        for r in rows
    ]


def hybrid_search(
    session: Session,
    *,
    query_text: str,
    query_embedding: list[float],
    workspace_id: str | None = None,
    kb_id: str | None = None,
    k: int,
    vector_k: int,
    bm25_k: int,
    vector_weight: float,
    bm25_weight: float,
    fts_config: str,
) -> list[RetrievedChunk]:
    vec = similarity_search(session, query_embedding=query_embedding, workspace_id=workspace_id, kb_id=kb_id, k=vector_k)
    lex = bm25_search(session, query=query_text, workspace_id=workspace_id, kb_id=kb_id, k=bm25_k, fts_config=fts_config)

    if not vec and not lex:
        return []
    if not lex:
        return vec[:k]
    if not vec:
        return lex[:k]

    vec_max = max((c.score for c in vec), default=0.0) or 1.0
    lex_max = max((c.score for c in lex), default=0.0) or 1.0

    combined: dict[int, RetrievedChunk] = {}
    scores: dict[int, float] = {}

    for c in vec:
        combined[c.chunk_id] = c
        scores[c.chunk_id] = scores.get(c.chunk_id, 0.0) + vector_weight * (c.score / vec_max)

    for c in lex:
        combined.setdefault(c.chunk_id, c)
        scores[c.chunk_id] = scores.get(c.chunk_id, 0.0) + bm25_weight * (c.score / lex_max)

    merged = [
        RetrievedChunk(
            chunk_id=c.chunk_id,
            url=c.url,
            title=c.title,
            section_path=c.section_path,
            text=c.text,
            score=float(scores.get(c.chunk_id, 0.0)),
        )
        for c in combined.values()
    ]
    merged.sort(key=lambda x: x.score, reverse=True)
    return merged[:k]
