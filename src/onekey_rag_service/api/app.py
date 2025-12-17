from __future__ import annotations

import asyncio
import datetime as dt
import logging
import uuid
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select
from sqlalchemy.orm import Session

from onekey_rag_service.api.deps import get_db
from onekey_rag_service.api.admin import router as admin_router
from onekey_rag_service.config import Settings, get_settings
from onekey_rag_service.admin.bootstrap import ensure_default_entities
from onekey_rag_service.db import (
    create_all_safe,
    create_db_engine,
    create_session_factory,
    ensure_admin_schema,
    ensure_indexes,
    ensure_pgvector_extension,
)
from onekey_rag_service.logging import configure_logging
from onekey_rag_service.models import Base, Feedback, Job, RagApp, RagAppKnowledgeBase, RetrievalEvent
from onekey_rag_service.rag.chat_provider import build_chat_provider, now_unix
from onekey_rag_service.rag.embeddings import build_embeddings_provider
from onekey_rag_service.rag.kb_allocation import KbBinding, allocate_top_k
from onekey_rag_service.rag.pipeline import answer_with_rag, prepare_rag
from onekey_rag_service.rag.reranker import build_reranker
from onekey_rag_service.utils import sha256_text
from onekey_rag_service.schemas import (
    FeedbackRequest,
    FeedbackResponse,
    HealthResponse,
    OpenAIChatCompletionsRequest,
    OpenAIChatCompletionsResponse,
    OpenAIChatCompletionsResponseChoice,
    OpenAIChatCompletionsResponseChoiceMessage,
    OpenAIUsage,
)

logger = logging.getLogger(__name__)

app = FastAPI(title="OneKey RAG Service", version="0.1.0")

# 前端 Widget（/widget/widget.js + /widget/）
_WIDGET_DIR = Path(__file__).resolve().parents[1] / "static" / "widget"
app.mount("/widget", StaticFiles(directory=str(_WIDGET_DIR), html=True, check_dir=False), name="widget")

# Admin UI（企业后台静态资源）
_ADMIN_UI_DIR = Path(__file__).resolve().parents[1] / "static" / "admin"
app.mount("/admin/ui", StaticFiles(directory=str(_ADMIN_UI_DIR), html=True, check_dir=False), name="admin_ui")

# Admin API
app.include_router(admin_router)


@app.middleware("http")
async def _widget_headers(request: Request, call_next):
    resp = await call_next(request)
    if request.url.path.startswith("/widget"):
        settings: Settings = getattr(request.app.state, "settings", get_settings())
        if settings.widget_frame_ancestors:
            resp.headers["Content-Security-Policy"] = f"frame-ancestors {settings.widget_frame_ancestors}"
    return resp


@app.exception_handler(HTTPException)
async def _openai_http_exception_handler(request: Request, exc: HTTPException):
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "error": {
                "message": exc.detail if isinstance(exc.detail, str) else str(exc.detail),
                "type": "invalid_request_error",
                "param": None,
                "code": None,
            }
        },
    )


@app.exception_handler(RequestValidationError)
async def _openai_validation_exception_handler(request: Request, exc: RequestValidationError):
    return JSONResponse(
        status_code=400,
        content={
            "error": {
                "message": "请求参数校验失败",
                "type": "invalid_request_error",
                "param": None,
                "code": None,
                "details": exc.errors(),
            }
        },
    )


@app.exception_handler(Exception)
async def _openai_unhandled_exception_handler(request: Request, exc: Exception):
    logger.exception("未处理异常 path=%s err=%s", request.url.path, exc)
    return JSONResponse(
        status_code=500,
        content={
            "error": {
                "message": "服务内部错误",
                "type": "internal_error",
                "param": None,
                "code": None,
            }
        },
    )
@app.on_event("startup")
def _startup() -> None:
    settings: Settings = get_settings()
    configure_logging(settings.log_level)

    engine = create_db_engine(settings)
    ensure_pgvector_extension(engine)
    create_all_safe(engine, Base.metadata)
    ensure_admin_schema(engine)
    ensure_indexes(engine, settings)

    app.state.settings = settings
    app.state.engine = engine
    app.state.SessionLocal = create_session_factory(engine)

    # 默认实体（workspace/kb/app/source）
    with app.state.SessionLocal() as session:
        ensure_default_entities(session, settings=settings)

    embeddings, embedding_model_name = build_embeddings_provider(settings)
    app.state.embeddings = embeddings
    app.state.embedding_model_name = embedding_model_name
    app.state.chat = build_chat_provider(settings)
    app.state.reranker = build_reranker(settings)
    app.state.chat_model_map = settings.chat_model_map()
    app.state.chat_semaphore = asyncio.Semaphore(max(1, int(settings.max_concurrent_chat_requests or 1)))

    logger.info("启动完成 env=%s", settings.app_env)


@app.get("/healthz", response_model=HealthResponse)
def healthz(settings: Settings = Depends(get_settings)) -> HealthResponse:
    return HealthResponse(status="ok", dependencies={"postgres": "ok", "pgvector": "ok"})


@app.get("/v1/models")
def openai_list_models(db: Session = Depends(get_db)):
    settings: Settings = app.state.settings

    apps = db.scalars(select(RagApp).where(RagApp.status == "published").order_by(RagApp.created_at.asc())).all()
    if apps:
        data = []
        for a in apps:
            chat_cfg = dict((a.config or {}).get("chat") or {})
            upstream_model = str(chat_cfg.get("model") or settings.chat_model)
            data.append(
                {
                    "id": a.public_model_id,
                    "object": "model",
                    "created": now_unix(),
                    "owned_by": "onekey",
                    "root": a.public_model_id,
                    "parent": None,
                    "meta": {
                        "app_id": a.id,
                        "upstream_model": upstream_model,
                        "base_url": str(settings.chat_base_url),
                    },
                }
            )
        return {"object": "list", "data": data}

    model_map: dict[str, str] = app.state.chat_model_map
    exposed = model_map or {"onekey-docs": settings.chat_model}
    return {
        "object": "list",
        "data": [
            {
                "id": model_id,
                "object": "model",
                "created": now_unix(),
                "owned_by": "onekey",
                "root": model_id,
                "parent": None,
                "meta": {"upstream_model": upstream_model, "base_url": str(settings.chat_base_url)},
            }
            for model_id, upstream_model in exposed.items()
        ],
    }


@app.post("/v1/chat/completions")
async def openai_chat_completions(
    req: OpenAIChatCompletionsRequest,
    db: Session = Depends(get_db),
):
    request_messages = [{"role": m.role, "content": m.content} for m in req.messages]
    question = ""
    for m in reversed(req.messages):
        if m.role == "user":
            question = m.content
            break
    if not question:
        raise HTTPException(status_code=400, detail="messages 中缺少 user 内容")

    settings: Settings = app.state.settings
    embeddings = app.state.embeddings
    chat = app.state.chat
    reranker = app.state.reranker
    model_map: dict[str, str] = app.state.chat_model_map

    workspace_id = "default"
    app_id = ""
    kb_allocations = None

    app_row = db.scalar(select(RagApp).where(RagApp.public_model_id == req.model))
    if app_row:
        if (app_row.status or "").lower() != "published":
            raise HTTPException(status_code=404, detail="model not found")
        workspace_id = str(app_row.workspace_id or "default")
        app_id = str(app_row.id or "")

        binding_rows = db.scalars(
            select(RagAppKnowledgeBase)
            .where(RagAppKnowledgeBase.workspace_id == workspace_id)
            .where(RagAppKnowledgeBase.app_id == app_id)
            .where(RagAppKnowledgeBase.enabled.is_(True))
            .order_by(RagAppKnowledgeBase.priority.asc(), RagAppKnowledgeBase.id.asc())
        ).all()
        bindings = [
            KbBinding(kb_id=b.kb_id, weight=float(b.weight or 0.0), priority=int(b.priority or 0))
            for b in binding_rows
            if (b.kb_id or "").strip() and float(b.weight or 0.0) > 0.0
        ]
        if not bindings:
            bindings = [KbBinding(kb_id="default", weight=1.0, priority=0)]
        kb_allocations = allocate_top_k(bindings, total_k=int(settings.rag_top_k))

        chat_cfg = dict((app_row.config or {}).get("chat") or {})
        upstream_model = str(chat_cfg.get("model") or settings.chat_model)
    else:
        if req.model in model_map:
            upstream_model = model_map[req.model]
        elif settings.chat_model_passthrough:
            upstream_model = req.model
        else:
            upstream_model = settings.chat_model

    temperature = req.temperature if req.temperature is not None else settings.chat_default_temperature
    top_p = req.top_p if req.top_p is not None else settings.chat_default_top_p
    max_tokens = req.max_tokens if req.max_tokens is not None else settings.chat_default_max_tokens

    chat_id = f"chatcmpl_{uuid.uuid4().hex}"
    created = now_unix()
    sem = getattr(app.state, "chat_semaphore", None)

    if not req.stream:
        if sem:
            await sem.acquire()
        try:
            rag = await asyncio.wait_for(
                answer_with_rag(
                    db,
                    settings=settings,
                    embeddings=embeddings,
                    chat=chat,
                    reranker=reranker,
                    chat_model=upstream_model,
                    request_messages=request_messages,
                    question=question,
                    workspace_id=workspace_id,
                    kb_allocations=kb_allocations,
                    temperature=temperature,
                    top_p=top_p,
                    max_tokens=max_tokens,
                    debug=req.debug,
                ),
                timeout=settings.rag_total_timeout_s,
            )
        except asyncio.TimeoutError:
            raise HTTPException(status_code=504, detail="请求超时，请稍后重试或缩短问题/上下文")
        except Exception as e:
            # 观测：非流式也应记录失败，便于 admin 聚合错误码与延迟
            _save_retrieval_event(
                db,
                settings=settings,
                workspace_id=workspace_id,
                app_id=app_id,
                request_id=chat_id,
                question=question,
                meta={
                    "workspace_id": workspace_id,
                    "requested_model": req.model,
                    "upstream_chat_model": upstream_model,
                },
                sources=[],
                usage=None,
                req_metadata=req.metadata,
                error=f"chat_error:{str(e)}",
            )
            raise
        finally:
            if sem:
                sem.release()

        meta = dict(rag.meta or {})
        meta["requested_model"] = req.model
        meta["upstream_chat_model"] = upstream_model
        meta["chat_model_provider"] = settings.chat_model_provider
        meta["chat_base_url"] = str(settings.chat_base_url)
        meta["embeddings_provider"] = settings.embeddings_provider
        meta["rerank_provider"] = settings.rerank_provider
        meta["retrieval_mode"] = settings.retrieval_mode

        _save_retrieval_event(
            db,
            settings=settings,
            workspace_id=workspace_id,
            app_id=app_id,
            request_id=chat_id,
            question=question,
            meta=meta,
            sources=rag.sources,
            usage=rag.usage,
            req_metadata=req.metadata,
            error="",
        )

        resp = OpenAIChatCompletionsResponse(
            id=chat_id,
            created=created,
            model=req.model,
            choices=[
                OpenAIChatCompletionsResponseChoice(
                    index=0,
                    message=OpenAIChatCompletionsResponseChoiceMessage(role="assistant", content=rag.answer),
                    finish_reason="stop",
                )
            ],
            usage=OpenAIUsage(**(rag.usage or {})),
            sources=rag.sources,  # type: ignore[arg-type]
            debug=rag.debug,
        )
        return JSONResponse(resp.model_dump())

    async def event_stream():
        if sem:
            await sem.acquire()
        try:
            # 首包声明 assistant 角色（部分 OpenAI 客户端依赖）
            yield f"data: {json_dumps({'id': chat_id,'object':'chat.completion.chunk','created': created,'model': req.model,'choices':[{'index':0,'delta':{'role':'assistant'},'finish_reason':None}]})}\n\n"

            prepared = None
            prepare_err = ""
            try:
                prepared = await asyncio.wait_for(
                    prepare_rag(
                        db,
                        settings=settings,
                        embeddings=embeddings,
                        chat=chat,
                        reranker=reranker,
                        chat_model=upstream_model,
                        request_messages=request_messages,
                        question=question,
                        workspace_id=workspace_id,
                        kb_allocations=kb_allocations,
                        debug=req.debug,
                    ),
                    timeout=settings.rag_prepare_timeout_s,
                )
            except asyncio.TimeoutError:
                prepare_err = "prepare_timeout"
                err_text = "\n\n[错误] 检索/上下文准备超时：请缩短问题或稍后重试"
                for part in _chunk_text(err_text, chunk_size=80):
                    data = {
                        "id": chat_id,
                        "object": "chat.completion.chunk",
                        "created": created,
                        "model": req.model,
                        "choices": [{"index": 0, "delta": {"content": part}, "finish_reason": None}],
                    }
                    yield f"data: {json_dumps(data)}\n\n"
            except Exception as e:
                prepare_err = f"prepare_error:{str(e)}"
                err_text = f"\n\n[错误] 检索/上下文准备失败：{str(e)}"
                for part in _chunk_text(err_text, chunk_size=80):
                    data = {
                        "id": chat_id,
                        "object": "chat.completion.chunk",
                        "created": created,
                        "model": req.model,
                        "choices": [{"index": 0, "delta": {"content": part}, "finish_reason": None}],
                    }
                    yield f"data: {json_dumps(data)}\n\n"

            sources = (prepared.sources if prepared else []) or []
            if prepared and isinstance(prepared.meta, dict):
                prepared.meta = dict(prepared.meta)
                prepared.meta["requested_model"] = req.model
                prepared.meta["upstream_chat_model"] = upstream_model
                prepared.meta["chat_model_provider"] = settings.chat_model_provider
                prepared.meta["chat_base_url"] = str(settings.chat_base_url)
                prepared.meta["embeddings_provider"] = settings.embeddings_provider
                prepared.meta["rerank_provider"] = settings.rerank_provider
                prepared.meta["retrieval_mode"] = settings.retrieval_mode

            event_meta = dict(prepared.meta or {}) if prepared else {}
            if event_meta is not None:
                event_meta.setdefault("requested_model", req.model)
                event_meta.setdefault("upstream_chat_model", upstream_model)
                event_meta.setdefault("chat_model_provider", settings.chat_model_provider)
                event_meta.setdefault("chat_base_url", str(settings.chat_base_url))
                event_meta.setdefault("embeddings_provider", settings.embeddings_provider)
                event_meta.setdefault("rerank_provider", settings.rerank_provider)
                event_meta.setdefault("retrieval_mode", settings.retrieval_mode)

            _save_retrieval_event(
                db,
                settings=settings,
                workspace_id=workspace_id,
                app_id=app_id,
                request_id=chat_id,
                question=question,
                meta=event_meta or None,
                sources=sources,
                usage=None,
                req_metadata=req.metadata,
                error=prepare_err,
            )

            # 可选：把 sources 以“参考/来源”形式附在最终文本里（便于只认 content 的客户端）
            sources_tail = ""
            if sources and settings.answer_append_sources:
                if settings.inline_citations_enabled:
                    lines = ["\n\n参考："]
                    for i, s in enumerate(sources, start=1):
                        ref = int(s.get("ref") or i)
                        title = (s.get("title") or "").strip()
                        url = (s.get("url") or "").strip()
                        if title:
                            lines.append(f"[{ref}] {title} - {url}")
                        else:
                            lines.append(f"[{ref}] {url}")
                    sources_tail = "\n".join(lines).rstrip()
                else:
                    sources_tail = "\n\n来源：\n" + "\n".join([f"- {s['url']}" for s in sources if s.get("url")])

            no_chat_text = ""
            if (not chat) and prepared and prepared.direct_answer is None and sources:
                no_chat_text = (
                    "当前服务未配置上游 ChatModel（CHAT_API_KEY），因此无法生成高质量自然语言回答。\n\n"
                    "下面是检索到的相关文档片段（请优先查看来源链接）：\n"
                    + "\n".join([f"- {s.get('title') or s.get('url')}（{s.get('url')}）" for s in sources[:5]])
                )

            if (not prepared) or prepared.direct_answer is not None or not prepared.messages or not chat:
                base_text = (prepared.direct_answer if prepared else "") or no_chat_text or ""
                tail = sources_tail if (prepared and prepared.direct_answer is not None) else ""
                for part in _chunk_text(base_text + tail, chunk_size=60):
                    data = {
                        "id": chat_id,
                        "object": "chat.completion.chunk",
                        "created": created,
                        "model": req.model,
                        "choices": [{"index": 0, "delta": {"content": part}, "finish_reason": None}],
                    }
                    yield f"data: {json_dumps(data)}\n\n"
            else:
                try:
                    async for part in chat.stream(
                        model=upstream_model,
                        messages=prepared.messages,
                        temperature=temperature,
                        top_p=top_p,
                        max_tokens=max_tokens,
                    ):
                        if not part:
                            continue
                        data = {
                            "id": chat_id,
                            "object": "chat.completion.chunk",
                            "created": created,
                            "model": req.model,
                            "choices": [{"index": 0, "delta": {"content": part}, "finish_reason": None}],
                        }
                        yield f"data: {json_dumps(data)}\n\n"

                    if sources_tail:
                        data = {
                            "id": chat_id,
                            "object": "chat.completion.chunk",
                            "created": created,
                            "model": req.model,
                            "choices": [{"index": 0, "delta": {"content": sources_tail}, "finish_reason": None}],
                        }
                        yield f"data: {json_dumps(data)}\n\n"
                except Exception as e:
                    # 流式过程中无法再改 HTTP 状态码，采用“内容内报错 + 结束事件”兜底
                    err_text = f"\n\n[错误] 上游模型流式输出失败：{str(e)}"
                    for part in _chunk_text(err_text, chunk_size=80):
                        data = {
                            "id": chat_id,
                            "object": "chat.completion.chunk",
                            "created": created,
                            "model": req.model,
                            "choices": [{"index": 0, "delta": {"content": part}, "finish_reason": None}],
                        }
                        yield f"data: {json_dumps(data)}\n\n"

            # 正常结束 chunk（OpenAI 习惯在最后给 finish_reason）
            yield f"data: {json_dumps({'id': chat_id,'object':'chat.completion.chunk','created': created,'model': req.model,'choices':[{'index':0,'delta':{},'finish_reason':'stop'}]})}\n\n"

            sources_event = {"id": chat_id, "object": "chat.completion.sources", "sources": sources}
            yield f"data: {json_dumps(sources_event)}\n\n"
            yield "data: [DONE]\n\n"
        finally:
            if sem:
                sem.release()

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.post("/v1/feedback", response_model=FeedbackResponse)
def feedback(req: FeedbackRequest, db: Session = Depends(get_db)) -> FeedbackResponse:
    # 优先从检索事件反查 app/workspace（前端无需额外传参）
    ev = (
        db.execute(select(RetrievalEvent).where(RetrievalEvent.request_id == req.message_id).order_by(RetrievalEvent.id.desc()).limit(1))
        .scalars()
        .first()
    )
    workspace_id = ev.workspace_id if ev else "default"
    app_id = ev.app_id if ev else ""

    # 企业级防重：同一 conversation/message 只保留一条记录，后写覆盖前写
    exists = db.execute(
        select(Feedback).where(
            Feedback.conversation_id == req.conversation_id,
            Feedback.message_id == req.message_id,
        )
    ).scalar_one_or_none()

    if exists:
        exists.workspace_id = workspace_id
        exists.app_id = app_id
        exists.rating = req.rating
        exists.reason = req.reason or ""
        exists.comment = req.comment or ""
        exists.sources = {"urls": req.sources or []}
        exists.created_at = dt.datetime.utcnow()
    else:
        fb = Feedback(
            workspace_id=workspace_id,
            app_id=app_id,
            conversation_id=req.conversation_id,
            message_id=req.message_id,
            rating=req.rating,
            reason=req.reason or "",
            comment=req.comment or "",
            sources={"urls": req.sources or []},
        )
        db.add(fb)

    db.commit()
    return FeedbackResponse()


def _save_retrieval_event(
    db: Session,
    *,
    settings: Settings,
    workspace_id: str,
    app_id: str,
    request_id: str,
    question: str,
    meta: dict | None,
    sources: list[dict],
    usage: dict | None,
    req_metadata: dict | None,
    error: str,
) -> None:
    if not settings.retrieval_events_enabled:
        return

    try:
        metadata = dict(req_metadata or {})
        conversation_id = str(metadata.get("conversation_id") or "")
        message_id = str(metadata.get("message_id") or "") or request_id

        kb_allocs = list((meta or {}).get("kb_allocations") or [])
        kb_ids = [str(a.get("kb_id") or "") for a in kb_allocs if str(a.get("kb_id") or "").strip()]

        retrieval_query = str((meta or {}).get("retrieval_query") or "")
        q_hash = sha256_text(question or "")
        rq_hash = sha256_text(retrieval_query) if retrieval_query else ""

        retrieval: dict[str, Any] = {}
        for k in [
            "retrieved",
            "chunk_ids",
            "scores",
            "top_chunk_ids",
            "top_scores",
            "top_scores_pre_rerank",
            "used_compaction",
            "rerank_used",
            # 观测：用于按模型/链路聚合
            "requested_model",
            "upstream_chat_model",
            "chat_model_provider",
            "chat_base_url",
            "embeddings_provider",
            "rerank_provider",
            "retrieval_mode",
        ]:
            if meta and k in meta:
                retrieval[k] = meta[k]
        retrieval["kb_allocations"] = kb_allocs

        sources_meta = {
            "items": [
                {
                    "ref": s.get("ref"),
                    "url": s.get("url"),
                    "title": s.get("title"),
                    "section_path": s.get("section_path"),
                }
                for s in (sources or [])
                if (s.get("url") or "").strip()
            ]
        }

        ev = RetrievalEvent(
            workspace_id=str(workspace_id or "default"),
            app_id=str(app_id or ""),
            kb_ids=kb_ids,
            request_id=str(request_id or ""),
            conversation_id=conversation_id,
            message_id=message_id,
            question_sha256=q_hash,
            question_len=len(question or ""),
            retrieval_query_sha256=rq_hash,
            retrieval_query_len=len(retrieval_query or ""),
            timings_ms=dict((meta or {}).get("timings_ms") or {}),
            retrieval=retrieval,
            sources=sources_meta,
            token_usage=dict(usage or {}),
            error=str(error or ""),
            created_at=dt.datetime.utcnow(),
        )
        db.add(ev)
        db.commit()
    except Exception as e:
        logger.warning("写入检索事件失败 request_id=%s err=%s", request_id, e)
        try:
            db.rollback()
        except Exception:
            pass


def _chunk_text(text: str, *, chunk_size: int) -> list[str]:
    if chunk_size <= 0:
        return [text]
    return [text[i : i + chunk_size] for i in range(0, len(text), chunk_size)]


def json_dumps(obj) -> str:
    import json

    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
