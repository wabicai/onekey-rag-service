import json
import logging

from fastapi import FastAPI
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.testclient import TestClient

from onekey_rag_service.access_log import (
    REQUEST_ID_HEADER,
    AccessLogMiddleware,
    access_logger,
    should_skip_access_log,
)


class _ListHandler(logging.Handler):
    def __init__(self) -> None:
        super().__init__()
        self.records: list[dict] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(json.loads(record.getMessage()))


def _app() -> FastAPI:
    app = FastAPI()
    app.add_middleware(AccessLogMiddleware)

    @app.get("/healthz")
    def healthz():
        return {"status": "ok"}

    @app.get("/widget/widget.js")
    def widget():
        return {"ok": True}

    @app.get("/v1/models")
    def models():
        return {"data": []}

    @app.post("/v1/chat/completions")
    def chat():
        return {"id": "chat"}

    @app.get("/boom")
    def boom():
        return JSONResponse(status_code=500, content={"error": {"message": "服务内部错误"}})

    @app.get("/stream")
    def stream():
        def chunks():
            yield "data: hi\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(chunks(), media_type="text/event-stream")

    return app


def _client(handler: _ListHandler) -> TestClient:
    access_logger.handlers = [handler]
    access_logger.setLevel(logging.INFO)
    access_logger.propagate = False
    return TestClient(_app())


def test_skip_paths():
    assert should_skip_access_log("/healthz")
    assert should_skip_access_log("/widget/widget.js")
    assert should_skip_access_log("/admin/ui")
    assert should_skip_access_log("/admin/ui/index.html")
    assert not should_skip_access_log("/admin/api/apps")
    assert not should_skip_access_log("/v1/chat/completions")
    assert not should_skip_access_log("/api/v1/contracts")


def test_generates_and_echoes_request_id():
    handler = _ListHandler()
    response = _client(handler).get("/v1/models")

    assert response.status_code == 200
    request_id = response.headers[REQUEST_ID_HEADER]
    assert len(request_id) == 32
    assert [item["_logType"] for item in handler.records] == ["request", "final_response"]
    assert handler.records[0]["requestId"] == request_id
    assert handler.records[1]["request_id"] == request_id
    assert handler.records[1]["_isFinalResponse"] is True
    assert handler.records[1]["httpStatus"] == 200
    assert handler.records[1]["code"] == 0
    assert handler.records[1]["tags"] == ["final", "api", "rag"]
    assert handler.records[0]["service"] == "onekey-rag-service"


def test_keeps_incoming_onekey_headers_and_client_ip():
    handler = _ListHandler()
    response = _client(handler).post(
        "/v1/chat/completions?model=rag",
        headers={
            "X-Onekey-Request-Id": "gateway-req-1",
            "X-Onekey-Request-Locale": "zh-cn",
            "X-Onekey-Request-Platform": "ios-phone",
            "X-Onekey-Request-Version": "5.16.0",
            "X-Onekey-Instance-Id": "device-1",
            "X-Onekey-Request-Theme": "dark",
            "x-amzn-trace-id": "Root=1-abc",
            "x-onekey-request-token": "secret-token",
            "true-client-ip": "203.0.113.8",
            "content-type": "application/json",
        },
        json={"messages": [{"role": "user", "content": "hello"}]},
    )

    assert response.status_code == 200
    assert response.headers[REQUEST_ID_HEADER] == "gateway-req-1"
    request_log = handler.records[0]
    assert request_log["requestId"] == "gateway-req-1"
    assert request_log["locale"] == "zh-cn"
    assert request_log["platform"] == "ios-phone"
    assert request_log["version"] == "5.16.0"
    assert request_log["userId"] == "device-1"
    assert request_log["walletType"] == "dark"
    assert request_log["traceId"] == "Root=1-abc"
    assert request_log["clientIp"] == "203.0.113.8"
    assert request_log["request"]["query"] == {"model": "rag"}
    assert request_log["request"]["body"]["messages"][0]["content"] == "hello"
    logged_headers = request_log["request"]["headers"]
    assert logged_headers[REQUEST_ID_HEADER] == "gateway-req-1"
    assert "x-onekey-request-token" not in logged_headers
    assert "authorization" not in logged_headers


def test_health_and_static_still_get_request_id_without_access_log():
    handler = _ListHandler()
    client = _client(handler)

    health = client.get("/healthz")
    widget = client.get("/widget/widget.js")

    assert health.status_code == 200
    assert widget.status_code == 200
    assert len(health.headers[REQUEST_ID_HEADER]) == 32
    assert len(widget.headers[REQUEST_ID_HEADER]) == 32
    assert handler.records == []


def test_server_error_is_final_response_error():
    handler = _ListHandler()
    response = _client(handler).get("/boom")

    assert response.status_code == 500
    final = handler.records[1]
    assert final["_logType"] == "final_response"
    assert final["level"] == "error"
    assert final["httpStatus"] == 500
    assert final["code"] == 500
    assert final["errCode"] == 500


def test_event_stream_is_not_buffered_into_the_log():
    handler = _ListHandler()
    response = _client(handler).get("/stream")

    assert response.status_code == 200
    assert "data: hi" in response.text
    assert handler.records[1]["response"] == {"stream": True}
