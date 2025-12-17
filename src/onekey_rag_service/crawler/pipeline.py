from __future__ import annotations

import datetime as dt
import logging
import re
from collections import deque
from dataclasses import dataclass
from urllib.parse import urljoin, urlparse, urlunparse

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session
from tenacity import retry, stop_after_attempt, wait_exponential

from onekey_rag_service.crawler.extract import extract_readable
from onekey_rag_service.crawler.sitemap import fetch_sitemap_urls
from onekey_rag_service.models import Page
from onekey_rag_service.utils import sha256_text

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class CrawlResult:
    discovered: int
    fetched: int
    succeeded: int
    failed: int


def _is_allowed_url(url: str, base_url: str) -> bool:
    try:
        u = urlparse(url)
        b = urlparse(base_url)
        return u.scheme in {"http", "https"} and u.netloc == b.netloc and url.startswith(base_url)
    except Exception:
        return False


def _compile_patterns(patterns: list[str] | None) -> list[re.Pattern[str]]:
    if not patterns:
        return []
    return [re.compile(p) for p in patterns]


def _match_any(url: str, patterns: list[re.Pattern[str]]) -> bool:
    return any(p.search(url) for p in patterns)


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=0.5, min=0.5, max=5))
async def _fetch_html(client: httpx.AsyncClient, url: str) -> httpx.Response:
    return await client.get(url, follow_redirects=True, timeout=30)


async def crawl_and_store_pages(
    session: Session,
    *,
    workspace_id: str,
    kb_id: str,
    source_id: str = "",
    base_url: str,
    sitemap_url: str,
    max_pages: int,
    seed_urls: list[str] | None = None,
    include_patterns: list[str] | None = None,
    exclude_patterns: list[str] | None = None,
    mode: str = "full",
) -> CrawlResult:
    include = _compile_patterns(include_patterns)
    exclude = _compile_patterns(exclude_patterns)

    async with httpx.AsyncClient(headers={"User-Agent": "onekey-rag-service/0.1"}) as client:
        initial: list[str] = []

        if sitemap_url:
            try:
                initial.extend(await fetch_sitemap_urls(client, sitemap_url))
            except Exception as e:
                logger.warning("读取 sitemap 失败，将降级为 seed_urls 抓取 sitemap_url=%s err=%s", sitemap_url, e)

        if seed_urls:
            initial.extend(seed_urls)

        if not initial:
            initial = [base_url]

        seen: set[str] = set()
        q: deque[str] = deque()
        for url in initial:
            url = _canonicalize_url(url, base_url)
            if not url:
                continue
            if not _is_allowed_url(url, base_url):
                continue
            if include and not _match_any(url, include):
                continue
            if exclude and _match_any(url, exclude):
                continue
            if url in seen:
                continue
            seen.add(url)
            q.append(url)

        discovered = len(seen)
        fetched = 0
        succeeded = 0
        failed = 0

        visited: set[str] = set()

        while q and len(visited) < max_pages:
            url = q.popleft()
            if url in visited:
                continue
            visited.add(url)
            fetched += 1
            try:
                resp = await _fetch_html(client, url)
                status = resp.status_code
                if status >= 400:
                    failed += 1
                    _upsert_page(
                        session,
                        url=url,
                        workspace_id=workspace_id,
                        kb_id=kb_id,
                        source_id=source_id,
                        title="",
                        content_markdown="",
                        content_hash="",
                        http_status=status,
                    )
                    continue

                title, content = extract_readable(resp.text)
                content_hash = sha256_text(content)

                if mode == "incremental":
                    existing_hash = session.scalar(select(Page.content_hash).where(Page.url == url))
                    if existing_hash and existing_hash == content_hash:
                        _touch_page(session, url=url, workspace_id=workspace_id, kb_id=kb_id, source_id=source_id, http_status=status)
                        succeeded += 1
                        _discover_links(resp.text, url, base_url, include, exclude, seen, q, max_pages=max_pages)
                        continue

                _upsert_page(
                    session,
                    url=url,
                    workspace_id=workspace_id,
                    kb_id=kb_id,
                    source_id=source_id,
                    title=title,
                    content_markdown=content,
                    content_hash=content_hash,
                    http_status=status,
                )
                succeeded += 1
                _discover_links(resp.text, url, base_url, include, exclude, seen, q, max_pages=max_pages)
            except Exception as e:
                logger.exception("抓取失败 url=%s err=%s", url, e)
                failed += 1
                _upsert_page(
                    session,
                    url=url,
                    workspace_id=workspace_id,
                    kb_id=kb_id,
                    source_id=source_id,
                    title="",
                    content_markdown="",
                    content_hash="",
                    http_status=0,
                )

        session.commit()
        return CrawlResult(discovered=max(discovered, len(seen)), fetched=fetched, succeeded=succeeded, failed=failed)


def _touch_page(session: Session, *, url: str, workspace_id: str, kb_id: str, source_id: str, http_status: int) -> None:
    page = session.scalar(select(Page).where(Page.url == url))
    if not page:
        return
    page.workspace_id = workspace_id
    page.kb_id = kb_id
    page.source_id = source_id
    page.http_status = http_status
    page.last_crawled_at = dt.datetime.utcnow()


def _upsert_page(
    session: Session,
    *,
    url: str,
    workspace_id: str,
    kb_id: str,
    source_id: str,
    title: str,
    content_markdown: str,
    content_hash: str,
    http_status: int,
) -> None:
    page = session.scalar(select(Page).where(Page.url == url))
    if not page:
        page = Page(url=url, workspace_id=workspace_id, kb_id=kb_id, source_id=source_id)
        session.add(page)
    else:
        # 兼容历史“单库”数据：允许在首次迁移时把旧 page 归属到指定 KB
        page.workspace_id = workspace_id
        page.kb_id = kb_id
        page.source_id = source_id

    page.title = title or page.title
    page.content_markdown = content_markdown or page.content_markdown
    page.content_hash = content_hash or page.content_hash
    page.http_status = http_status
    page.last_crawled_at = dt.datetime.utcnow()


def _canonicalize_url(url: str, base_url: str) -> str | None:
    if not url:
        return None
    if url.startswith("#"):
        return None
    if url.startswith("mailto:") or url.startswith("tel:") or url.startswith("javascript:"):
        return None

    abs_url = urljoin(base_url, url)
    parsed = urlparse(abs_url)
    parsed = parsed._replace(fragment="")

    # 过滤常见静态资源
    path = (parsed.path or "").lower()
    if re.search(r"\.(png|jpe?g|gif|svg|ico|css|js|json|xml|pdf|zip|mp4|webm)$", path):
        return None

    return urlunparse(parsed)


def _discover_links(
    html: str,
    current_url: str,
    base_url: str,
    include: list[re.Pattern[str]],
    exclude: list[re.Pattern[str]],
    seen: set[str],
    q: deque[str],
    *,
    max_pages: int,
) -> None:
    if len(seen) >= max_pages:
        return

    # 仅做最小化的链接发现：站内 <a href>，过滤静态资源与非 http(s)
    try:
        from bs4 import BeautifulSoup
    except Exception:
        return

    soup = BeautifulSoup(html, "lxml")
    for a in soup.find_all("a"):
        href = a.get("href")
        url = _canonicalize_url(href or "", current_url)
        if not url:
            continue
        if not _is_allowed_url(url, base_url):
            continue
        if include and not _match_any(url, include):
            continue
        if exclude and _match_any(url, exclude):
            continue
        if url in seen:
            continue
        seen.add(url)
        q.append(url)
        if len(seen) >= max_pages:
            break
