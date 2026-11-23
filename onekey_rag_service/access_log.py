"""统一访问日志。

对齐 server-service-utility 的 TraceIdMiddleware + AccessLogMiddleware：
所有 HTTP 入口读取 OneKey 自定义请求头，缺省时生成 x-onekey-request-id，
并在同一出口打印 request / final_response 两条 JSON 日志。
"""

from __future__ import annotations

import asyncio
import contextvars
import json
import logging
import os
import secrets
import time
from datetime import datetime, timezone
from typing import Any
from urllib.parse import parse_qsl

SERVICE_NAME = "onekey-rag-service"

# 与 wallet / utility 的 HttpHeadersMap 保持一致。header 名大小写不敏感。
REQUEST_ID_HEADER = "x-onekey-request-id"
TRACE_HEADERS = {
    "locale": "x-onekey-request-locale",
    "platform": "x-onekey-request-platform",
    "version": "x-onekey-request-version",
    "js_bundle_version": "x-onekey-request-jsbundle-version",
    "request_id": REQUEST_ID_HEADER,
    "currency": "x-onekey-request-currency",
    "currency_value": "x-onekey-request-currency-value",
    "instance_id": "x-onekey-instance-id",
    "theme": "x-onekey-request-theme",
    "lb_trace_id": "x-amzn-trace-id",
}
LOGGED_HEADER_NAMES = frozenset(TRACE_HEADERS.values())
# 保密头不进访问日志，和 utility 的 SecretHttpHeaderMap 一样排除。
SECRET_HEADER_NAMES = frozenset({"x-onekey-request-token", "authorization", "cookie"})

SKIP_LOG_PATHS = frozenset({"/healthz"})
SKIP_LOG_PREFIXES = ("/widget", "/admin/ui")

MAX_LOG_BODY_BYTES = 4096
MAX_BUFFER_BODY_BYTES = 1_000_000

_request_id: contextvars.ContextVar[str | None] = contextvars.ContextVar("onekey_request_id", default=None)

access_logger = logging.getLogger("onekey.access")


def get_request_id() -> str | None:
    return _request_id.get()


def _ensure_access_logger() -> None:
    if access_logger.handlers:
        return
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(message)s"))
    access_logger.addHandler(handler)
    access_logger.setLevel(logging.INFO)
    access_logger.propagate = False


def _header_map(scope: dict[str, Any]) -> dict[str, str]:
    headers: dict[str, str] = {}
    for key, value in scope.get("headers") or []:
        name = key.decode("latin1").lower()
        headers[name] = value.decode("latin1")
    return headers


def _client_ip(headers: dict[str, str], scope: dict[str, Any]) -> str:
    true_client_ip = headers.get("true-client-ip", "").strip()
    if true_client_ip:
        return true_client_ip
    forwarded = headers.get("x-forwarded-for", "")
    if forwarded:
        first = forwarded.split(",", 1)[0].strip()
        if first:
            return first
    client = scope.get("client")
    if client and client[0]:
        return str(client[0])
    return ""


def _query(scope: dict[str, Any]) -> dict[str, str]:
    raw = scope.get("query_string") or b""
    if isinstance(raw, bytes):
        text = raw.decode("latin1")
    else:
        text = str(raw)
    return dict(parse_qsl(text, keep_blank_values=True))


def _logged_headers(headers: dict[str, str]) -> dict[str, str]:
    picked = {name: headers[name] for name in LOGGED_HEADER_NAMES if headers.get(name)}
    return picked


def _body_for_log(raw: bytes, content_type: str) -> Any:
    if not raw:
        return None
    content_type = content_type.lower()
    if "multipart/" in content_type:
        return {"omitted": "multipart"}
    truncated = len(raw) > MAX_LOG_BODY_BYTES
    sample = raw[:MAX_LOG_BODY_BYTES]
    if "application/json" in content_type or content_type.endswith("+json"):
        try:
            parsed = json.loads(sample if not truncated else raw[:MAX_LOG_BODY_BYTES])
        except json.JSONDecodeError:
            parsed = None
        if parsed is not None and not truncated:
            return parsed
        if parsed is not None:
            return {"truncated": True, "preview": parsed}
    text = sample.decode("utf-8", "replace")
    if truncated:
        return text + "…"
    return text


def _response_for_log(raw: bytes, content_type: str, stream: bool) -> Any:
    if stream:
        return {"stream": True}
    return _body_for_log(raw, content_type)


def _omit_empty(payload: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in payload.items() if value not in (None, "", [], {})}


def build_access_record(
    *,
    level: str,
    log_type: str,
    method: str,
    url: str,
    headers: dict[str, str],
    client_ip: str,
    code: int = 0,
    http_status: int | None = None,
    duration_ms: int | None = None,
    request: dict[str, Any] | None = None,
    response: Any = None,
    error: dict[str, Any] | None = None,
    final: bool = False,
) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    request_id = headers.get(REQUEST_ID_HEADER, "")
    record: dict[str, Any] = {
        "service": SERVICE_NAME,
        "env": os.environ.get("APP_ENV") or "local",
        "timestampISO": now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z",
        "timestampUnixMs": int(now.timestamp() * 1000),
        "level": level,
        "code": code,
        "errCode": code,
        "traceId": headers.get("x-amzn-trace-id", ""),
        "requestId": request_id,
        "request_id": request_id,
        "clientIp": client_ip,
        "userId": headers.get("x-onekey-instance-id", ""),
        "locale": headers.get("x-onekey-request-locale", ""),
        "platform": headers.get("x-onekey-request-platform", ""),
        "version": headers.get("x-onekey-request-version", ""),
        "walletType": headers.get("x-onekey-request-theme", ""),
        "source": url.split("?", 1)[0],
        "url": url,
        "method": method,
        "_logType": log_type,
        "tags": ["final", "api", "rag"] if final else ["request", "api", "rag"],
    }
    if final:
        record["_isFinalResponse"] = True
        record["httpStatus"] = http_status
        record["durationMs"] = duration_ms
        record["response"] = response
        if error:
            record["error"] = error
    else:
        record["request"] = request
    return _omit_empty(record)


def emit_access_log(record: dict[str, Any]) -> None:
    _ensure_access_logger()
    level = str(record.get("level") or "info").lower()
    line = json.dumps(record, ensure_ascii=False, default=str, separators=(",", ":"))
    log = getattr(access_logger, level, None)
    if not callable(log):
        log = access_logger.info
    log(line)


def should_skip_access_log(path: str) -> bool:
    if path in SKIP_LOG_PATHS:
        return True
    return any(path == prefix or path.startswith(prefix + "/") for prefix in SKIP_LOG_PREFIXES)


def _request_url(scope: dict[str, Any]) -> str:
    path = scope.get("path") or "/"
    query = scope.get("query_string") or b""
    if isinstance(query, bytes):
        query_text = query.decode("latin1")
    else:
        query_text = str(query)
    if query_text:
        return f"{path}?{query_text}"
    return path


async def _read_body(receive: Any) -> bytes:
    chunks: list[bytes] = []
    while True:
        message = await receive()
        if message["type"] == "http.disconnect":
            break
        if message["type"] != "http.request":
            continue
        chunks.append(message.get("body") or b"")
        if not message.get("more_body", False):
            break
    return b"".join(chunks)


def _replay_receive(body: bytes):
    sent = False

    async def receive() -> dict[str, Any]:
        nonlocal sent
        if not sent:
            sent = True
            return {"type": "http.request", "body": body, "more_body": False}
        # 请求体已经读完。后续 receive 是在等客户端断开，不能立刻再回一个 request，
        # 否则 StreamingResponse 的断开监听会空转，流式响应发不完。
        await asyncio.Event().wait()
        return {"type": "http.disconnect"}

    return receive


class AccessLogMiddleware:
    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = _header_map(scope)
        request_id = headers.get(REQUEST_ID_HEADER, "").strip() or secrets.token_hex(16)
        headers[REQUEST_ID_HEADER] = request_id
        scope = dict(scope)
        raw_headers = [(key, value) for key, value in scope.get("headers") or [] if key.lower() != REQUEST_ID_HEADER.encode()]
        raw_headers.append((REQUEST_ID_HEADER.encode(), request_id.encode()))
        scope["headers"] = raw_headers
        state = scope.get("state")
        if isinstance(state, dict):
            state["request_id"] = request_id
        else:
            scope["state"] = {"request_id": request_id}

        path = scope.get("path") or "/"
        method = scope.get("method") or ""
        url = _request_url(scope)
        content_type = headers.get("content-type", "")
        try:
            content_length = int(headers.get("content-length") or "0")
        except ValueError:
            content_length = 0
        skip_log = should_skip_access_log(path)
        client_ip = _client_ip(headers, scope)
        token = _request_id.set(request_id)
        started = time.perf_counter()
        status_code = 500
        response_chunks = bytearray()
        response_type = ""
        stream = False
        error_info: dict[str, Any] | None = None
        request_receive = receive

        async def send_wrapper(message: dict[str, Any]) -> None:
            nonlocal status_code, response_type, stream
            if message["type"] == "http.response.start":
                status_code = int(message["status"])
                raw = [(key, value) for key, value in message.get("headers") or [] if key.lower() != REQUEST_ID_HEADER.encode()]
                raw.append((REQUEST_ID_HEADER.encode(), request_id.encode()))
                message = {**message, "headers": raw}
                for key, value in raw:
                    if key.lower() == b"content-type":
                        response_type = value.decode("latin1")
                        stream = response_type.lower().startswith("text/event-stream")
                        break
            elif message["type"] == "http.response.body" and not stream and not skip_log:
                if len(response_chunks) < MAX_LOG_BODY_BYTES:
                    response_chunks.extend(message.get("body") or b"")
            await send(message)

        try:
            buffer_body = content_length <= MAX_BUFFER_BODY_BYTES and "multipart/" not in content_type.lower()
            if buffer_body:
                body = await _read_body(receive)
                request_receive = _replay_receive(body)
                logged_body = None if skip_log else _body_for_log(body, content_type)
            else:
                logged_body = {"omitted": "multipart" if "multipart/" in content_type.lower() else "too_large"}

            if not skip_log:
                try:
                    emit_access_log(
                        build_access_record(
                            level="info",
                            log_type="request",
                            method=method,
                            url=url,
                            headers=headers,
                            client_ip=client_ip,
                            request={
                                "query": _query(scope),
                                "body": logged_body,
                                "headers": _logged_headers(headers),
                            },
                        )
                    )
                except Exception:
                    logging.getLogger(__name__).exception("access request log failed")
            await self.app(scope, request_receive, send_wrapper)
        except Exception as exc:
            error_info = {"message": str(exc), "type": type(exc).__name__}
            raise
        finally:
            if not skip_log:
                duration_ms = int((time.perf_counter() - started) * 1000)
                code = 0 if error_info is None and status_code < 400 else status_code
                if error_info is not None or status_code >= 500:
                    level = "error"
                elif status_code >= 400:
                    level = "warn"
                else:
                    level = "info"
                try:
                    emit_access_log(
                        build_access_record(
                            level=level,
                            log_type="final_response",
                            method=method,
                            url=url,
                            headers=headers,
                            client_ip=client_ip,
                            code=code,
                            http_status=status_code,
                            duration_ms=duration_ms,
                            response=_response_for_log(bytes(response_chunks), response_type, stream),
                            error=error_info,
                            final=True,
                        )
                    )
                except Exception:
                    logging.getLogger(__name__).exception("access final log failed")
            _request_id.reset(token)
