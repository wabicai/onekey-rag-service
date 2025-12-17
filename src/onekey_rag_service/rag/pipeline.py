from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass

from sqlalchemy.orm import Session

from onekey_rag_service.config import Settings
from onekey_rag_service.rag.chat_provider import ChatProvider
from onekey_rag_service.rag.conversation import compact_conversation, extract_system_instructions, format_history_excerpt
from onekey_rag_service.rag.embeddings import EmbeddingsProvider
from onekey_rag_service.rag.pgvector_store import RetrievedChunk, hybrid_search, similarity_search
from onekey_rag_service.rag.reranker import Reranker
from onekey_rag_service.rag.kb_allocation import KbAllocation
from onekey_rag_service.utils import clamp_text

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class RagAnswer:
    answer: str
    sources: list[dict]
    debug: dict | None = None
    usage: dict | None = None
    meta: dict | None = None


@dataclass(frozen=True)
class RagPrepared:
    """RAG 预处理产物：检索/重排/上下文拼接 + 最终给上游模型的 messages。"""

    messages: list[dict] | None
    sources: list[dict]
    debug: dict | None = None
    direct_answer: str | None = None
    meta: dict | None = None


def _merge_candidates(candidates: list[list[RetrievedChunk]], *, k: int) -> list[RetrievedChunk]:
    by_id: dict[int, RetrievedChunk] = {}
    for group in candidates:
        for c in group:
            prev = by_id.get(c.chunk_id)
            if (not prev) or c.score > prev.score:
                by_id[c.chunk_id] = c
    merged = list(by_id.values())
    merged.sort(key=lambda x: x.score, reverse=True)
    return merged[:k]


def _build_sources(chunks: list[RetrievedChunk], *, max_sources: int = 6) -> list[dict]:
    seen: set[str] = set()
    sources: list[dict] = []

    for c in sorted(chunks, key=lambda x: x.score, reverse=True):
        url = _append_anchor(c.url, c.section_path)
        if url in seen:
            continue
        seen.add(url)
        sources.append(
            {
                "url": url,
                "title": c.title,
                "section_path": c.section_path,
                "snippet": "",
            }
        )
        if len(sources) >= max_sources:
            break
    return sources


_CITATION_RE = re.compile(r"\[(\d{1,3})\]")


def _slugify_anchor(text: str) -> str:
    s = (text or "").strip().lower()
    s = re.sub(r"[^\w\s-]", "", s, flags=re.UNICODE)
    s = re.sub(r"\s+", "-", s)
    s = re.sub(r"-{2,}", "-", s).strip("-")
    return s


def _append_anchor(url: str, section_path: str) -> str:
    if not url or "#" in url:
        return url
    last = (section_path or "").split(" > ")[-1].strip()
    anchor = _slugify_anchor(last)
    if not anchor:
        return url
    return f"{url}#{anchor}"


def _sanitize_inline_citations(text: str, *, max_ref: int) -> str:
    """
    删除模型输出中越界的引用编号（例如 [99]），避免前端无法对齐 sources。
    """

    def _repl(m: re.Match[str]) -> str:
        try:
            n = int(m.group(1))
        except Exception:
            return ""
        return m.group(0) if 1 <= n <= max_ref else ""

    cleaned = _CITATION_RE.sub(_repl, text or "")
    cleaned = re.sub(r" {2,}", " ", cleaned)
    return cleaned.strip()


def _has_any_inline_citation(text: str) -> bool:
    return bool(_CITATION_RE.search(text or ""))


def _build_references_tail(*, sources: list[dict], inline: bool) -> str:
    if not sources:
        return ""
    if inline:
        lines = ["\n\n参考："]
        for i, s in enumerate(sources, start=1):
            ref = int(s.get("ref") or i)
            title = (s.get("title") or "").strip()
            url = (s.get("url") or "").strip()
            if title:
                lines.append(f"[{ref}] {title} - {url}")
            else:
                lines.append(f"[{ref}] {url}")
        return "\n".join(lines).rstrip()

    lines = ["\n\n来源："] + [f"- {(s.get('url') or '').strip()}" for s in sources if (s.get("url") or "").strip()]
    return "\n".join(lines).rstrip()


def _fill_source_snippets(sources: list[dict], chunks: list[RetrievedChunk], *, snippet_max_chars: int) -> None:
    by_url: dict[str, RetrievedChunk] = {}
    for c in sorted(chunks, key=lambda x: x.score, reverse=True):
        by_url.setdefault(c.url, c)

    for s in sources:
        url = s.get("url") or ""
        c = by_url.get(url)
        if not c:
            continue
        s["snippet"] = clamp_text(c.text.replace("\n", " ").strip(), snippet_max_chars)


def _build_inline_sources(chunks: list[RetrievedChunk], *, snippet_max_chars: int, max_sources: int) -> list[dict]:
    sources: list[dict] = []
    for i, c in enumerate(chunks[:max_sources], start=1):
        sources.append(
            {
                "ref": i,
                "url": _append_anchor(c.url, c.section_path),
                "title": c.title,
                "section_path": c.section_path,
                "snippet": clamp_text(c.text.replace("\n", " ").strip(), snippet_max_chars),
            }
        )
    return sources


def _build_context(chunks: list[RetrievedChunk], *, max_chars: int = 12_000) -> str:
    parts: list[str] = []
    total = 0
    for i, c in enumerate(chunks, start=1):
        block = f"[{i}]\nURL: {c.url}\n标题: {c.title}\n章节: {c.section_path}\n内容:\n{c.text}\n"
        if total + len(block) > max_chars:
            break
        parts.append(block)
        total += len(block)
    return "\n\n".join(parts).strip()


async def prepare_rag(
    session: Session,
    *,
    settings: Settings,
    embeddings: EmbeddingsProvider,
    chat: ChatProvider | None,
    reranker: Reranker | None,
    chat_model: str,
    request_messages: list[dict],
    question: str,
    workspace_id: str = "default",
    kb_allocations: list[KbAllocation] | None = None,
    debug: bool = False,
) -> RagPrepared:
    t_prepare = time.perf_counter()
    t_compaction_ms: int | None = None
    t_embed_ms: int | None = None
    t_retrieve_ms: int | None = None
    t_rerank_ms: int | None = None
    t_context_ms: int | None = None

    system_instructions = extract_system_instructions(request_messages)
    history_messages = list(request_messages)
    for i in range(len(history_messages) - 1, -1, -1):
        if (history_messages[i].get("role") or "") == "user":
            history_messages.pop(i)
            break

    history_excerpt = format_history_excerpt(
        history_messages,
        max_messages=settings.conversation_history_max_messages,
        max_chars=settings.conversation_history_max_chars,
    )

    retrieval_query = question
    memory_summary: str | None = None
    used_compaction = False
    if chat and (settings.query_rewrite_enabled or settings.memory_summary_enabled):
        t0 = time.perf_counter()
        try:
            compaction = await compact_conversation(
                settings=settings,
                chat=chat,
                model=chat_model,
                messages=request_messages,
                question=question,
            )
            retrieval_query = compaction.retrieval_query
            memory_summary = compaction.memory_summary
            used_compaction = compaction.used_llm
            t_compaction_ms = int((time.perf_counter() - t0) * 1000)
        except Exception:
            # Query rewrite/记忆压缩属于“增强项”，失败不应影响主链路
            retrieval_query = question
            memory_summary = None
            used_compaction = False
            t_compaction_ms = int((time.perf_counter() - t0) * 1000)

    t0 = time.perf_counter()
    qvec = embeddings.embed_query(retrieval_query)
    t_embed_ms = int((time.perf_counter() - t0) * 1000)
    mode = (settings.retrieval_mode or "vector").lower()
    t0 = time.perf_counter()
    allocations = [a for a in (kb_allocations or []) if int(a.top_k or 0) > 0]
    if allocations:
        groups: list[list[RetrievedChunk]] = []
        for a in allocations:
            per_k = max(1, int(a.top_k))
            if mode == "hybrid":
                groups.append(
                    hybrid_search(
                        session,
                        query_text=retrieval_query,
                        query_embedding=qvec,
                        workspace_id=workspace_id,
                        kb_id=a.kb_id,
                        k=per_k,
                        vector_k=min(settings.hybrid_vector_k, per_k),
                        bm25_k=min(settings.hybrid_bm25_k, per_k),
                        vector_weight=settings.hybrid_vector_weight,
                        bm25_weight=settings.hybrid_bm25_weight,
                        fts_config=settings.bm25_fts_config,
                    )
                )
            else:
                groups.append(
                    similarity_search(
                        session,
                        query_embedding=qvec,
                        workspace_id=workspace_id,
                        kb_id=a.kb_id,
                        k=per_k,
                    )
                )
        retrieved = _merge_candidates(groups, k=settings.rag_top_k)
    else:
        if mode == "hybrid":
            retrieved = hybrid_search(
                session,
                query_text=retrieval_query,
                query_embedding=qvec,
                workspace_id=workspace_id,
                kb_id=None,
                k=settings.rag_top_k,
                vector_k=settings.hybrid_vector_k,
                bm25_k=settings.hybrid_bm25_k,
                vector_weight=settings.hybrid_vector_weight,
                bm25_weight=settings.hybrid_bm25_weight,
                fts_config=settings.bm25_fts_config,
            )
        else:
            retrieved = similarity_search(
                session,
                query_embedding=qvec,
                workspace_id=workspace_id,
                kb_id=None,
                k=settings.rag_top_k,
            )
    t_retrieve_ms = int((time.perf_counter() - t0) * 1000)
    ranked = retrieved
    rerank_used = bool(reranker)
    if reranker:
        t0 = time.perf_counter()
        try:
            ranked = await reranker.rerank(query=retrieval_query, candidates=retrieved, top_n=settings.rag_top_n)
        except Exception:
            ranked = retrieved[: settings.rag_top_n]
        t_rerank_ms = int((time.perf_counter() - t0) * 1000)

    max_ctx = min(settings.rag_top_n, settings.rag_max_sources) if settings.inline_citations_enabled else settings.rag_top_n
    topn = ranked[:max_ctx]
    orig_score_by_id = {c.chunk_id: c.score for c in retrieved}
    top_scores_pre_rerank = [orig_score_by_id.get(c.chunk_id) for c in topn] if rerank_used else None
    if settings.inline_citations_enabled:
        sources = _build_inline_sources(topn, snippet_max_chars=settings.rag_snippet_max_chars, max_sources=max_ctx)
    else:
        sources = _build_sources(topn, max_sources=settings.rag_max_sources)
        _fill_source_snippets(sources, topn, snippet_max_chars=settings.rag_snippet_max_chars)

    if not topn:
        return RagPrepared(
            messages=None,
            direct_answer="我在 OneKey 开发者文档中没有检索到直接相关的内容。你可以换一种问法，或提供更具体的关键词（如 SDK 名称/方法名/报错信息）。",
            sources=[],
            debug={"retrieved": 0, "retrieval_query": retrieval_query, "used_compaction": used_compaction} if debug else None,
            meta={
                "workspace_id": workspace_id,
                "kb_allocations": [a.__dict__ for a in allocations],
                "retrieval_query": retrieval_query,
                "retrieved": 0,
                "rerank_used": rerank_used,
                "timings_ms": {
                    "compaction": t_compaction_ms,
                    "embed": t_embed_ms,
                    "retrieve": t_retrieve_ms,
                    "rerank": t_rerank_ms,
                    "context": t_context_ms,
                    "total_prepare": int((time.perf_counter() - t_prepare) * 1000),
                },
                "used_compaction": used_compaction,
            },
        )

    t0 = time.perf_counter()
    context = _build_context(topn, max_chars=settings.rag_context_max_chars)
    t_context_ms = int((time.perf_counter() - t0) * 1000)

    system = "你是 OneKey 开发者文档助手。你必须严格基于提供的“文档片段”回答，不要编造。"

    extra = ""
    if system_instructions:
        extra += f"用户额外要求（如与规则冲突，以规则为准）：\n{system_instructions}\n\n"
    if memory_summary:
        extra += f"对话摘要（压缩记忆）：\n{memory_summary}\n\n"
    if history_excerpt:
        extra += f"最近对话片段：\n{history_excerpt}\n\n"

    citation_rules = ""
    if settings.inline_citations_enabled:
        citation_rules = (
            "引用规则（重要）：\n"
            f"- 你只能引用编号 1..{len(topn)}，引用格式为 [数字]，例如 [1]。\n"
            "- 每个关键结论/步骤后都要给出至少一个引用；如果文档片段不足以支撑，请明确说“不确定/文档未说明”。\n"
            "- 不要在正文里堆砌 URL；只用 [n] 这种 inline citation。\n\n"
        )

    formatting_rules = (
        "格式要求（重要）：\n"
        "- 请使用 Markdown 输出。\n"
        "- 对变量名/方法名/参数名/字段名/命令/路径/报错关键词等“短代码片段”，使用反引号包裹（inline code），例如 `connectId`、`HardwareSDK.init()`。\n"
        "- 不要把单个标识符/字段名（例如 `device_id`、`connectId`）单独放在一行或代码块里；尽量写在句子中。\n"
        "- 对多行代码/命令/配置使用代码块（fenced code block），并尽量标注语言，例如 ```ts / ```bash / ```json。\n"
        "- 代码块优先用于“≥2 行”或需要复制执行的命令/配置；不要为了展示一个词/一个参数就用代码块。\n"
        "- 除代码块外，不要把短标识符单独换行。\n\n"
    )

    user = (
        f"{extra}"
        f"当前问题：{question}\n\n"
        f"文档片段（可引用）：\n{context}\n\n"
        f"{formatting_rules}"
        f"{citation_rules}"
        "请用中文给出：\n"
        "1) 简要结论（1-3 句）\n"
        "2) 具体步骤（分点）\n"
        "3) 若文档片段包含代码/配置，请给出对应示例\n"
        "4) 注意事项/常见坑（如有）\n"
    )

    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]

    debug_obj: dict | None = None
    if debug:
        debug_obj = {
            "retrieved": len(retrieved),
            "chunk_ids": [c.chunk_id for c in retrieved],
            "top_chunk_ids": [c.chunk_id for c in topn],
            "top_scores": [c.score for c in topn],
            "top_scores_pre_rerank": top_scores_pre_rerank,
            "rerank_used": rerank_used,
            "retrieval_query": retrieval_query,
            "used_compaction": used_compaction,
            "timings_ms": {
                "compaction": t_compaction_ms,
                "embed": t_embed_ms,
                "retrieve": t_retrieve_ms,
                "rerank": t_rerank_ms,
                "context": t_context_ms,
                "total_prepare": int((time.perf_counter() - t_prepare) * 1000),
            },
        }

    return RagPrepared(
        messages=messages,
        sources=sources,
        debug=debug_obj,
        meta={
            "workspace_id": workspace_id,
            "kb_allocations": [a.__dict__ for a in allocations],
            "retrieval_query": retrieval_query,
            "retrieved": len(retrieved),
            "chunk_ids": [c.chunk_id for c in retrieved],
            "scores": [c.score for c in retrieved],
            "top_chunk_ids": [c.chunk_id for c in topn],
            "top_scores": [c.score for c in topn],
            "top_scores_pre_rerank": top_scores_pre_rerank,
            "rerank_used": rerank_used,
            "timings_ms": {
                "compaction": t_compaction_ms,
                "embed": t_embed_ms,
                "retrieve": t_retrieve_ms,
                "rerank": t_rerank_ms,
                "context": t_context_ms,
                "total_prepare": int((time.perf_counter() - t_prepare) * 1000),
            },
            "used_compaction": used_compaction,
        },
    )


async def answer_with_rag(
    session: Session,
    *,
    settings: Settings,
    embeddings: EmbeddingsProvider,
    chat: ChatProvider | None,
    reranker: Reranker | None,
    chat_model: str,
    request_messages: list[dict],
    question: str,
    workspace_id: str = "default",
    kb_allocations: list[KbAllocation] | None = None,
    temperature: float | None = None,
    top_p: float | None = None,
    max_tokens: int | None = None,
    debug: bool = False,
) -> RagAnswer:
    prepared = await prepare_rag(
        session,
        settings=settings,
        embeddings=embeddings,
        chat=chat,
        reranker=reranker,
        chat_model=chat_model,
        request_messages=request_messages,
        question=question,
        workspace_id=workspace_id,
        kb_allocations=kb_allocations,
        debug=debug,
    )

    if prepared.direct_answer is not None:
        return RagAnswer(answer=prepared.direct_answer, sources=prepared.sources, debug=prepared.debug, meta=prepared.meta)

    if not prepared.messages:
        return RagAnswer(
            answer="我在 OneKey 开发者文档中没有检索到直接相关的内容。你可以换一种问法，或提供更具体的关键词（如 SDK 名称/方法名/报错信息）。",
            sources=[],
            debug=prepared.debug,
            meta=prepared.meta,
        )

    sources = prepared.sources

    if not chat:
        # 降级：无上游模型时，返回可用片段的摘要式回答（确保服务可运行）
        answer = (
            "当前服务暂时没有搜索到可用信息。\n\n"
            "下面是检索到的可能的相关文档片段（请优先查看来源链接）：\n"
            + "\n".join([f"- {s['title'] or s['url']}（{s['url']}）" for s in sources[:5]])
        )
        return RagAnswer(answer=answer, sources=sources, debug=prepared.debug, meta=prepared.meta)

    t0 = time.perf_counter()
    result = await chat.complete(
        model=chat_model,
        messages=prepared.messages,
        temperature=temperature,
        top_p=top_p,
        max_tokens=max_tokens,
    )
    chat_ms = int((time.perf_counter() - t0) * 1000)

    # 观测：把 chat 耗时写入 meta，便于 admin 聚合统计（不依赖 debug=true）
    try:
        timings_meta = dict((prepared.meta or {}).get("timings_ms") or {})
        timings_meta["chat"] = chat_ms
        if "total_prepare" in timings_meta and isinstance(timings_meta.get("total_prepare"), (int, float)):
            timings_meta["total"] = int(timings_meta["total_prepare"]) + int(chat_ms)
        prepared.meta["timings_ms"] = timings_meta
    except Exception:
        pass

    content = (result.content or "").strip()
    if settings.inline_citations_enabled:
        content = _sanitize_inline_citations(content, max_ref=len(sources))
        # 如果模型没按要求输出引用，至少在末尾补一个参考（避免“无可追溯”）
        if sources and not _has_any_inline_citation(content):
            content = (content + "\n\n（未能在正文中生成引用标记，已在参考中列出来源）").strip()

    if sources and settings.answer_append_sources:
        content += _build_references_tail(sources=sources, inline=settings.inline_citations_enabled)

    debug_obj = prepared.debug
    if debug_obj is not None:
        timings = dict(debug_obj.get("timings_ms") or {})
        timings["chat"] = chat_ms
        debug_obj = {**debug_obj, "timings_ms": timings}

    return RagAnswer(
        answer=content,
        sources=sources,
        usage=result.usage,
        debug=debug_obj,
        meta=prepared.meta,
    )
