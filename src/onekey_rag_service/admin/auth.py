from __future__ import annotations

import base64
import datetime as dt
import hashlib
import hmac
import json
from dataclasses import dataclass
from typing import Any

from fastapi import Depends, HTTPException, Request

from onekey_rag_service.config import Settings, get_settings
from onekey_rag_service.models import DEFAULT_WORKSPACE_ID


@dataclass(frozen=True)
class AdminPrincipal:
    username: str
    role: str
    workspace_id: str


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64url_decode(s: str) -> bytes:
    padded = s + "=" * ((4 - (len(s) % 4)) % 4)
    return base64.urlsafe_b64decode(padded.encode("ascii"))


def _hmac_sha256(key: str, msg: str) -> bytes:
    return hmac.new(key.encode("utf-8"), msg.encode("utf-8"), hashlib.sha256).digest()


def _utcnow_ts() -> int:
    return int(dt.datetime.utcnow().timestamp())


def create_jwt(payload: dict[str, Any], *, secret: str) -> str:
    header = {"alg": "HS256", "typ": "JWT"}
    header_b64 = _b64url_encode(json.dumps(header, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
    payload_b64 = _b64url_encode(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
    signing_input = f"{header_b64}.{payload_b64}"
    sig_b64 = _b64url_encode(_hmac_sha256(secret, signing_input))
    return f"{signing_input}.{sig_b64}"


def verify_jwt(token: str, *, secret: str, issuer: str) -> dict[str, Any]:
    try:
        header_b64, payload_b64, sig_b64 = token.split(".", 2)
    except ValueError as e:
        raise HTTPException(status_code=401, detail="无效 token") from e

    signing_input = f"{header_b64}.{payload_b64}"
    expected = _b64url_encode(_hmac_sha256(secret, signing_input))
    if not hmac.compare_digest(expected, sig_b64):
        raise HTTPException(status_code=401, detail="无效 token")

    try:
        payload = json.loads(_b64url_decode(payload_b64))
    except Exception as e:
        raise HTTPException(status_code=401, detail="无效 token") from e

    if not isinstance(payload, dict):
        raise HTTPException(status_code=401, detail="无效 token")

    iss = str(payload.get("iss") or "")
    if issuer and iss != issuer:
        raise HTTPException(status_code=401, detail="无效 token")

    exp = int(payload.get("exp") or 0)
    if exp and _utcnow_ts() >= exp:
        raise HTTPException(status_code=401, detail="token 已过期")

    return payload


def authenticate_admin(*, username: str, password: str, settings: Settings) -> AdminPrincipal:
    u_ok = hmac.compare_digest((username or "").strip(), (settings.admin_username or "").strip())
    p_ok = hmac.compare_digest(password or "", settings.admin_password or "")
    if not (u_ok and p_ok):
        raise HTTPException(status_code=401, detail="用户名或密码错误", headers={"WWW-Authenticate": "Bearer"})
    return AdminPrincipal(username=settings.admin_username, role="owner", workspace_id=DEFAULT_WORKSPACE_ID)


def issue_admin_access_token(principal: AdminPrincipal, *, settings: Settings) -> tuple[str, int]:
    now = _utcnow_ts()
    exp = now + max(60, int(settings.admin_jwt_expires_s or 3600))
    payload = {
        "iss": "onekey-rag-admin",
        "sub": principal.username,
        "role": principal.role,
        "workspace_id": principal.workspace_id,
        "iat": now,
        "exp": exp,
    }
    return create_jwt(payload, secret=settings.admin_jwt_secret), exp - now


def require_admin(request: Request, settings: Settings = Depends(get_settings)) -> AdminPrincipal:
    auth = request.headers.get("Authorization") or ""
    if not auth.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="缺少 Authorization: Bearer token", headers={"WWW-Authenticate": "Bearer"})
    token = auth.split(" ", 1)[1].strip()
    payload = verify_jwt(token, secret=settings.admin_jwt_secret, issuer="onekey-rag-admin")

    sub = str(payload.get("sub") or "")
    role = str(payload.get("role") or "")
    workspace_id = str(payload.get("workspace_id") or DEFAULT_WORKSPACE_ID)
    if not sub:
        raise HTTPException(status_code=401, detail="无效 token", headers={"WWW-Authenticate": "Bearer"})
    return AdminPrincipal(username=sub, role=role or "viewer", workspace_id=workspace_id)

