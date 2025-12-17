from __future__ import annotations

import asyncio
import datetime as dt
import logging
import os
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from onekey_rag_service.config import Settings, get_settings
from onekey_rag_service.crawler.pipeline import crawl_and_store_pages
from onekey_rag_service.admin.bootstrap import ensure_default_entities
from onekey_rag_service.db import create_all_safe, create_db_engine, create_session_factory, ensure_admin_schema, ensure_indexes, ensure_pgvector_extension
from onekey_rag_service.indexing.pipeline import index_pages_to_chunks
from onekey_rag_service.logging import configure_logging
from onekey_rag_service.models import Base, Job
from onekey_rag_service.rag.embeddings import build_embeddings_provider

logger = logging.getLogger(__name__)


def _utcnow() -> dt.datetime:
    # 与 models.py 的默认值保持一致（naive utc）
    return dt.datetime.utcnow()


def _read_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except Exception:
        return default


def _read_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except Exception:
        return default


def _merge_job_meta(progress: dict, *, worker_id: str, attempts: int) -> dict:
    base = dict(progress or {})
    meta = dict(base.get("_meta") or {})
    meta.update({"worker_id": worker_id, "attempts": attempts, "updated_at": _utcnow().isoformat()})
    base["_meta"] = meta
    return base


def _requeue_stale_jobs(session: Session, *, stale_after_s: int) -> int:
    if stale_after_s <= 0:
        return 0
    threshold = _utcnow() - dt.timedelta(seconds=stale_after_s)
    stale = (
        session.scalars(
            select(Job)
            .where(Job.status == "running")
            .where(Job.started_at < threshold)
            .order_by(Job.started_at.asc())
            .limit(10)
            .with_for_update(skip_locked=True)
        )
        .all()
    )
    for j in stale:
        j.status = "queued"
        j.error = (j.error + "\n[worker] 检测到任务运行超时，已重新入队").strip()
    return len(stale)


def _claim_next_job(session: Session) -> Job | None:
    job = (
        session.scalars(
            select(Job)
            .where(Job.status == "queued")
            .order_by(Job.started_at.asc())
            .limit(1)
            .with_for_update(skip_locked=True)
        )
        .first()
    )
    if not job:
        return None
    job.status = "running"
    job.started_at = _utcnow()
    job.error = ""
    return job


async def _handle_crawl_job(session: Session, *, settings: Settings, payload: dict[str, Any]) -> dict:
    result = await crawl_and_store_pages(
        session,
        workspace_id=str(payload.get("workspace_id") or "default"),
        kb_id=str(payload.get("kb_id") or "default"),
        source_id=str(payload.get("source_id") or ""),
        base_url=str(payload.get("base_url") or settings.crawl_base_url),
        sitemap_url=str(payload.get("sitemap_url") or payload.get("CRAWL_SITEMAP_URL") or settings.crawl_sitemap_url),
        max_pages=int(payload.get("max_pages") or settings.crawl_max_pages),
        seed_urls=payload.get("seed_urls"),
        include_patterns=payload.get("include_patterns"),
        exclude_patterns=payload.get("exclude_patterns"),
        mode=str(payload.get("mode") or "full"),
    )
    return result.__dict__


def _handle_index_job(
    session: Session,
    *,
    settings: Settings,
    embeddings,
    embedding_model_name: str,
    payload: dict[str, Any],
) -> dict:
    mode = str(payload.get("mode") or "incremental")
    return index_pages_to_chunks(
        session,
        embeddings=embeddings,
        embedding_model_name=embedding_model_name,
        workspace_id=str(payload.get("workspace_id") or "default"),
        kb_id=str(payload.get("kb_id") or "default"),
        chunk_max_chars=settings.chunk_max_chars,
        chunk_overlap_chars=settings.chunk_overlap_chars,
        mode=mode,
    )


async def _process_job(
    session_factory,
    *,
    settings: Settings,
    worker_id: str,
    job_id: str,
    embeddings,
    embedding_model_name: str,
    max_attempts: int,
) -> None:
    with session_factory() as session:
        job = session.get(Job, job_id)
        if not job:
            return
        if job.status != "running":
            return

        meta = dict((job.progress or {}).get("_meta") or {})
        attempts = int(meta.get("attempts") or 0) + 1
        job.progress = _merge_job_meta(job.progress, worker_id=worker_id, attempts=attempts)
        session.commit()

    t0 = _utcnow()
    err: str | None = None
    progress: dict | None = None
    try:
        with session_factory() as session:
            job = session.get(Job, job_id)
            if not job:
                return
            payload = dict(job.payload or {})

            if job.type == "crawl":
                progress = await _handle_crawl_job(session, settings=settings, payload=payload)
            elif job.type == "index":
                progress = _handle_index_job(
                    session,
                    settings=settings,
                    embeddings=embeddings,
                    embedding_model_name=embedding_model_name,
                    payload=payload,
                )
            else:
                raise RuntimeError(f"未知 job.type: {job.type}")
    except Exception as e:
        err = str(e)

    final_type = ""
    final_status = ""
    with session_factory() as session:
        job = session.get(Job, job_id)
        if not job:
            return

        meta = dict((job.progress or {}).get("_meta") or {})
        attempts = int(meta.get("attempts") or 1)

        if err:
            job.error = err
            if max_attempts > 0 and attempts < max_attempts:
                job.status = "queued"
            else:
                job.status = "failed"
                job.finished_at = _utcnow()
        else:
            job.status = "succeeded"
            job.finished_at = _utcnow()
            job.progress = _merge_job_meta(progress or {}, worker_id=worker_id, attempts=attempts)

        final_type = job.type
        final_status = job.status
        session.commit()

    cost_ms = int((_utcnow() - t0).total_seconds() * 1000)
    logger.info("job done id=%s type=%s status=%s cost_ms=%s", job_id, final_type, final_status, cost_ms)


async def main() -> None:
    settings: Settings = get_settings()
    configure_logging(settings.log_level)

    engine = create_db_engine(settings)
    ensure_pgvector_extension(engine)
    create_all_safe(engine, Base.metadata)
    ensure_admin_schema(engine)
    ensure_indexes(engine, settings)
    session_factory = create_session_factory(engine)

    with session_factory() as session:
        ensure_default_entities(session, settings=settings)

    embeddings, embedding_model_name = build_embeddings_provider(settings)

    worker_id = os.getenv("WORKER_ID") or f"worker_{uuid.uuid4().hex[:10]}"
    poll_interval_s = _read_float("WORKER_POLL_INTERVAL_S", 1.0)
    stale_after_s = _read_int("WORKER_STALE_AFTER_S", 3600)
    max_attempts = _read_int("WORKER_MAX_ATTEMPTS", 3)

    logger.info(
        "worker started id=%s jobs_backend=%s poll_interval_s=%s stale_after_s=%s max_attempts=%s",
        worker_id,
        settings.jobs_backend,
        poll_interval_s,
        stale_after_s,
        max_attempts,
    )

    while True:
        job_id: str | None = None
        job_type: str | None = None
        with session_factory() as session:
            with session.begin():
                requeued = _requeue_stale_jobs(session, stale_after_s=stale_after_s)
                job = _claim_next_job(session)
                if requeued:
                    logger.warning("requeued stale jobs count=%s", requeued)
                if job:
                    job_id = job.id
                    job_type = job.type
                    logger.info("job claimed id=%s type=%s", job_id, job_type)

        if not job_id:
            await asyncio.sleep(poll_interval_s)
            continue

        try:
            await _process_job(
                session_factory,
                settings=settings,
                worker_id=worker_id,
                job_id=job_id,
                embeddings=embeddings,
                embedding_model_name=embedding_model_name,
                max_attempts=max_attempts,
            )
        except Exception as e:
            logger.exception("worker loop failed job_id=%s type=%s err=%s", job_id, job_type, e)
            await asyncio.sleep(1.0)


if __name__ == "__main__":
    asyncio.run(main())
