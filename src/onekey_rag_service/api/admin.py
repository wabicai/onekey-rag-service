from __future__ import annotations

import datetime as dt
import os
import platform
import shutil
import time
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import delete, desc, func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from onekey_rag_service.admin.auth import AdminPrincipal, authenticate_admin, issue_admin_access_token, require_admin
from onekey_rag_service.api.deps import get_db
from onekey_rag_service.config import Settings, get_settings
from onekey_rag_service.models import (
    Chunk,
    DataSource,
    Feedback,
    Job,
    KnowledgeBase,
    Page,
    RagApp,
    RagAppKnowledgeBase,
    RetrievalEvent,
    Workspace,
)

router = APIRouter(prefix="/admin/api", tags=["admin"])

_PROC_START_MONO = time.monotonic()
_last_proc_cpu_sample: dict[str, float] | None = None
_last_sys_cpu_sample: dict[str, float] | None = None
_last_cgroup_cpu_sample: dict[str, float] | None = None
_last_storage_sample: dict[str, Any] | None = None
_last_storage_sample_ts: float | None = None


def _utcnow() -> dt.datetime:
    return dt.datetime.utcnow()


def _require_workspace_access(principal: AdminPrincipal, workspace_id: str) -> None:
    # 当前阶段：单个超管账号，默认只允许访问 token 里的 workspace。
    # 后续引入用户/成员体系后，再放开到“可访问的 workspaces 列表”。
    if principal.workspace_id and principal.workspace_id != workspace_id:
        raise HTTPException(status_code=403, detail="无权访问该 workspace")


def _parse_pagination(page: int, page_size: int) -> tuple[int, int, int]:
    p = max(1, int(page or 1))
    ps = max(1, min(200, int(page_size or 20)))
    offset = (p - 1) * ps
    return p, ps, offset


class AdminLoginRequest(BaseModel):
    username: str = Field(default="")
    password: str = Field(default="")


class AdminLoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int


class AdminMeResponse(BaseModel):
    username: str
    role: str
    workspace_id: str


class WorkspaceItem(BaseModel):
    id: str
    name: str


class SummaryResponse(BaseModel):
    pages: dict[str, Any]
    chunks: dict[str, Any]
    jobs: dict[str, Any]
    feedback: dict[str, Any]
    indexes: dict[str, Any]


class HealthResponse(BaseModel):
    status: str
    dependencies: dict[str, Any]


def _read_meminfo_bytes() -> dict[str, int]:
    """
    读取 /proc/meminfo（Linux）并转换为 bytes。
    失败时返回空 dict（便于容器/非 Linux 环境降级）。
    """

    try:
        out: dict[str, int] = {}
        with open("/proc/meminfo", "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or ":" not in line:
                    continue
                k, rest = line.split(":", 1)
                parts = rest.strip().split()
                if not parts:
                    continue
                try:
                    v = int(parts[0])
                except Exception:
                    continue
                unit = parts[1] if len(parts) > 1 else ""
                if unit.lower() == "kb":
                    out[k] = v * 1024
                elif unit.lower() == "b":
                    out[k] = v
                else:
                    # meminfo 大多是 kB；未知单位先按 bytes 处理，避免误导
                    out[k] = v
        return out
    except Exception:
        return {}


def _read_proc_rss_bytes() -> int | None:
    """
    读取当前进程 RSS（Linux /proc/self/status）。
    """

    try:
        with open("/proc/self/status", "r", encoding="utf-8") as f:
            for line in f:
                if not line.startswith("VmRSS:"):
                    continue
                parts = line.split()
                if len(parts) < 2:
                    return None
                kb = int(parts[1])
                return kb * 1024
        return None
    except Exception:
        return None


def _read_proc_cpu_times_s() -> float | None:
    """
    返回当前进程累计 CPU 时间（user+sys，单位秒）。
    该值可用于计算“近一段时间 CPU 使用率”。
    """

    try:
        # 依赖标准库：resource 在 Linux 下单位为秒
        import resource

        ru = resource.getrusage(resource.RUSAGE_SELF)
        return float(ru.ru_utime + ru.ru_stime)
    except Exception:
        return None


def _read_sys_cpu_jiffies() -> tuple[int, int] | None:
    """
    读取 /proc/stat 的总 CPU jiffies，返回 (total, idle)。
    idle = idle + iowait（更贴近“不可用”时间）
    """

    try:
        with open("/proc/stat", "r", encoding="utf-8") as f:
            line = f.readline().strip()
        if not line.startswith("cpu "):
            return None
        parts = line.split()
        vals = [int(x) for x in parts[1:] if x.isdigit() or (x and x[0].isdigit())]
        if len(vals) < 4:
            return None
        idle = vals[3] + (vals[4] if len(vals) > 4 else 0)
        total = sum(vals)
        return total, idle
    except Exception:
        return None


def _read_cgroup_limits() -> dict[str, Any]:
    """
    读取 cgroup v2/v1 的 CPU/内存限制信息（容器环境）。
    不保证所有字段都有；尽量做到“有就展示、没有就跳过”。
    """

    out: dict[str, Any] = {}

    # cgroup v2：/sys/fs/cgroup/cpu.max, memory.max
    try:
        cpu_max = ""
        with open("/sys/fs/cgroup/cpu.max", "r", encoding="utf-8") as f:
            cpu_max = f.read().strip()
        # 格式："{quota} {period}" 或 "max {period}"
        quota_s, period_s = (cpu_max.split() + ["", ""])[:2]
        if quota_s and period_s:
            out["cpu"] = {"quota_us": None, "period_us": int(period_s), "limit_cores": None}
            if quota_s != "max":
                quota_us = int(quota_s)
                out["cpu"]["quota_us"] = quota_us
                out["cpu"]["limit_cores"] = round(quota_us / int(period_s), 4) if int(period_s) > 0 else None
    except Exception:
        pass

    try:
        mem_max = ""
        with open("/sys/fs/cgroup/memory.max", "r", encoding="utf-8") as f:
            mem_max = f.read().strip()
        mem_cur = ""
        with open("/sys/fs/cgroup/memory.current", "r", encoding="utf-8") as f:
            mem_cur = f.read().strip()

        limit = None if mem_max == "max" else int(mem_max)
        current = int(mem_cur) if mem_cur.isdigit() else None
        out["memory"] = {"limit_bytes": limit, "current_bytes": current}
    except Exception:
        pass

    # cgroup v1：memory.limit_in_bytes, cpu.cfs_quota_us
    if not out.get("memory"):
        try:
            with open("/sys/fs/cgroup/memory/memory.limit_in_bytes", "r", encoding="utf-8") as f:
                limit = int(f.read().strip())
            with open("/sys/fs/cgroup/memory/memory.usage_in_bytes", "r", encoding="utf-8") as f:
                current = int(f.read().strip())
            out["memory"] = {"limit_bytes": limit, "current_bytes": current}
        except Exception:
            pass

    if not out.get("cpu"):
        try:
            with open("/sys/fs/cgroup/cpu/cpu.cfs_quota_us", "r", encoding="utf-8") as f:
                quota_us = int(f.read().strip())
            with open("/sys/fs/cgroup/cpu/cpu.cfs_period_us", "r", encoding="utf-8") as f:
                period_us = int(f.read().strip())
            out["cpu"] = {"quota_us": quota_us, "period_us": period_us, "limit_cores": None}
            if quota_us > 0 and period_us > 0:
                out["cpu"]["limit_cores"] = round(quota_us / period_us, 4)
        except Exception:
            pass

    return out


def _read_cgroup_cpu_stat() -> dict[str, int]:
    """
    读取 cgroup v2 cpu.stat（容器环境更可信）。
    参考字段：usage_usec/user_usec/system_usec/nr_throttled/throttled_usec 等。
    """

    out: dict[str, int] = {}
    try:
        with open("/sys/fs/cgroup/cpu.stat", "r", encoding="utf-8") as f:
            for line in f:
                parts = line.strip().split()
                if len(parts) != 2:
                    continue
                k, v = parts
                try:
                    out[k] = int(v)
                except Exception:
                    continue
    except Exception:
        return {}
    return out


def _read_cgroup_cpuset_effective() -> str | None:
    """
    读取 cgroup v2 的 cpuset.cpus.effective（例如：0-3,6）。
    """

    for p in ("/sys/fs/cgroup/cpuset.cpus.effective", "/sys/fs/cgroup/cpuset.cpus"):
        try:
            with open(p, "r", encoding="utf-8") as f:
                s = f.read().strip()
            if s:
                return s
        except Exception:
            continue
    return None


def _count_cpuset_cpus(cpuset: str | None) -> int | None:
    """
    统计 cpuset.cpus.effective 的 CPU 数量。
    """

    s = (cpuset or "").strip()
    if not s:
        return None
    total = 0
    for part in s.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a_s, b_s = (part.split("-", 1) + [""])[:2]
            try:
                a = int(a_s)
                b = int(b_s)
            except Exception:
                continue
            if b >= a:
                total += b - a + 1
            continue
        try:
            int(part)
        except Exception:
            continue
        total += 1
    return total or None


def _compute_cgroup_cpu_usage(*, limit_cores: float | None, cpuset_count: int | None) -> dict[str, Any]:
    """
    基于 cgroup cpu.stat 的 usage_usec 计算“容器（cgroup）CPU 使用率”。

    - usage_cores_used：近一段时间平均使用核数
    - usage_percent_of_limit：相对“有效限额核数”的百分比（0-100）

    说明：首次调用无法计算 delta，将返回空字段；前端应做占位。
    """

    global _last_cgroup_cpu_sample

    now = time.time()
    stat = _read_cgroup_cpu_stat()
    usage_usec = float(stat.get("usage_usec") or 0)
    throttled_usec = float(stat.get("throttled_usec") or 0)

    effective_limit = None
    if limit_cores is not None and cpuset_count is not None:
        effective_limit = float(min(limit_cores, float(cpuset_count)))
    elif limit_cores is not None:
        effective_limit = float(limit_cores)
    elif cpuset_count is not None:
        effective_limit = float(cpuset_count)
    else:
        effective_limit = float(os.cpu_count() or 1)

    out: dict[str, Any] = {
        "cpu_stat": stat,
        "effective_limit_cores": round(effective_limit, 4) if effective_limit else None,
    }

    if _last_cgroup_cpu_sample:
        dt_wall = now - float(_last_cgroup_cpu_sample["ts"])
        dt_usage_s = (usage_usec - float(_last_cgroup_cpu_sample["usage_usec"])) / 1_000_000.0
        dt_throttled_s = (throttled_usec - float(_last_cgroup_cpu_sample["throttled_usec"])) / 1_000_000.0
        if dt_wall > 0 and dt_usage_s >= 0:
            cores_used = dt_usage_s / dt_wall
            out["usage_cores_used"] = round(cores_used, 3)
            if effective_limit and effective_limit > 0:
                out["usage_percent_of_limit"] = round(max(0.0, min(100.0, cores_used / effective_limit * 100.0)), 2)
            if effective_limit and effective_limit > 0:
                out["throttled_percent_of_limit"] = round(max(0.0, min(100.0, dt_throttled_s / (dt_wall * effective_limit) * 100.0)), 2)

    _last_cgroup_cpu_sample = {"ts": now, "usage_usec": usage_usec, "throttled_usec": throttled_usec}
    return out


def _read_postgres_storage_stats(db: Session) -> dict[str, Any]:
    """
    返回“数据库存储体积”信息（用于运维/容量管理）。

    注意：该指标反映 Postgres 数据库内的表/索引占用，更贴近 RAG 成本（chunks/retrieval_events）；
    相比容器 rootfs 的 overlay 容量，上线/本地 Docker Desktop 都更具可解释性。
    """

    out: dict[str, Any] = {}
    try:
        db_bytes = int(db.execute(text("SELECT pg_database_size(current_database())")).scalar() or 0)
    except Exception:
        return {}

    out["db_bytes"] = db_bytes

    # 只统计本服务关注的核心表；避免遍历系统表/全库导致开销过大
    tables = [
        "chunks",
        "pages",
        "retrieval_events",
        "jobs",
        "feedback",
        "knowledge_bases",
        "data_sources",
        "rag_apps",
        "app_kbs",
        "workspaces",
    ]

    items: list[dict[str, Any]] = []
    for t in tables:
        try:
            row = db.execute(
                text(
                    """
                    SELECT
                      pg_total_relation_size(CAST(:tbl AS regclass)) AS total_bytes,
                      pg_relation_size(CAST(:tbl AS regclass)) AS table_bytes,
                      pg_indexes_size(CAST(:tbl AS regclass)) AS index_bytes
                    """
                ),
                {"tbl": f"public.{t}"},
            ).first()
        except Exception:
            continue
        if not row:
            continue
        total_b = int(row[0] or 0)
        table_b = int(row[1] or 0)
        index_b = int(row[2] or 0)
        items.append({"name": t, "total_bytes": total_b, "table_bytes": table_b, "index_bytes": index_b})

    items.sort(key=lambda x: int(x.get("total_bytes") or 0), reverse=True)
    out["tables"] = items
    return out


def _get_storage_cached(db: Session, *, ttl_s: float = 30.0) -> dict[str, Any]:
    """
    由于 Dashboard 可能频繁轮询，存储统计做轻量缓存，避免每次都打 pg_*size 查询。
    """

    global _last_storage_sample, _last_storage_sample_ts

    now = time.time()
    if _last_storage_sample_ts is not None and _last_storage_sample and (now - _last_storage_sample_ts) < ttl_s:
        return _last_storage_sample

    sample = {"now": _utcnow().isoformat(), "postgres": _read_postgres_storage_stats(db)}
    _last_storage_sample = sample
    _last_storage_sample_ts = now
    return sample


def _compute_cpu_percents() -> dict[str, Any]:
    """
    计算 CPU 使用率（基于上一次采样的 delta），首次调用会返回 None。
    - system.cpu_percent：全机（或容器视角）CPU 使用率
    - process.cpu_percent_of_total：进程占用“总 CPU 容量”的百分比（0-100）
    - process.cpu_cores_used：进程近似占用的核数（0-cores）
    """

    global _last_proc_cpu_sample, _last_sys_cpu_sample

    now = time.time()
    out: dict[str, Any] = {"system": {}, "process": {}}

    # system cpu
    sys_j = _read_sys_cpu_jiffies()
    if sys_j:
        total, idle = sys_j
        if _last_sys_cpu_sample:
            dt_total = float(total - int(_last_sys_cpu_sample["total"]))
            dt_idle = float(idle - int(_last_sys_cpu_sample["idle"]))
            if dt_total > 0:
                out["system"]["cpu_percent"] = round(max(0.0, min(100.0, (dt_total - dt_idle) / dt_total * 100.0)), 2)
        _last_sys_cpu_sample = {"ts": now, "total": float(total), "idle": float(idle)}

    # process cpu
    proc_cpu_s = _read_proc_cpu_times_s()
    if proc_cpu_s is not None:
        if _last_proc_cpu_sample:
            dt_wall = now - float(_last_proc_cpu_sample["ts"])
            dt_cpu = proc_cpu_s - float(_last_proc_cpu_sample["cpu_s"])
            if dt_wall > 0 and dt_cpu >= 0:
                cores = float(os.cpu_count() or 1)
                out["process"]["cpu_cores_used"] = round(dt_cpu / dt_wall, 3)
                out["process"]["cpu_percent_of_total"] = round(max(0.0, min(100.0, dt_cpu / (dt_wall * cores) * 100.0)), 2)
        _last_proc_cpu_sample = {"ts": now, "cpu_s": float(proc_cpu_s)}

    return out


@router.get("/workspaces/{workspace_id}/system")
def workspace_system(
    workspace_id: str,
    principal: AdminPrincipal = Depends(require_admin),
) -> dict[str, Any]:
    """
    返回当前服务进程与系统（容器视角）的资源与运行信息，用于 Admin 总览展示。
    """

    _require_workspace_access(principal, workspace_id)

    meminfo = _read_meminfo_bytes()
    mem_total = int(meminfo.get("MemTotal") or 0)
    mem_avail = int(meminfo.get("MemAvailable") or 0)
    mem_used = mem_total - mem_avail if mem_total and mem_avail else None
    mem_used_pct = (float(mem_used) / float(mem_total) * 100.0) if (mem_used is not None and mem_total) else None

    rss = _read_proc_rss_bytes()
    proc_cpu_total_s = _read_proc_cpu_times_s()
    cpu_delta = _compute_cpu_percents()

    try:
        load1, load5, load15 = os.getloadavg()
    except Exception:
        load1, load5, load15 = None, None, None

    try:
        # /proc/uptime: "uptime idle"
        with open("/proc/uptime", "r", encoding="utf-8") as f:
            up = f.read().strip().split()[0]
        sys_uptime_s = float(up)
    except Exception:
        sys_uptime_s = None

    cgroup = _read_cgroup_limits()
    cpuset_eff = _read_cgroup_cpuset_effective()
    cpuset_cnt = _count_cpuset_cpus(cpuset_eff)
    if cgroup.get("cpu") is None:
        cgroup["cpu"] = {}
    if isinstance(cgroup.get("cpu"), dict):
        cgroup["cpu"]["cpuset_cpus_effective"] = cpuset_eff
        cgroup["cpu"]["cpuset_count"] = cpuset_cnt
        limit_cores = cgroup["cpu"].get("limit_cores")
        try:
            limit_cores_f = float(limit_cores) if limit_cores is not None else None
        except Exception:
            limit_cores_f = None
        cgroup["cpu"].update(_compute_cgroup_cpu_usage(limit_cores=limit_cores_f, cpuset_count=cpuset_cnt))

    if isinstance(cgroup.get("memory"), dict):
        cur = cgroup["memory"].get("current_bytes")
        lim = cgroup["memory"].get("limit_bytes")
        try:
            cur_i = int(cur) if cur is not None else None
        except Exception:
            cur_i = None
        try:
            lim_i = int(lim) if lim is not None else None
        except Exception:
            lim_i = None
        effective_limit = lim_i if (lim_i is not None and lim_i > 0) else (mem_total or None)
        if effective_limit:
            cgroup["memory"]["effective_limit_bytes"] = int(effective_limit)
            if cur_i is not None:
                cgroup["memory"]["used_percent_of_effective_limit"] = round(
                    max(0.0, min(100.0, cur_i / float(effective_limit) * 100.0)), 2
                )

    disk_root = None
    try:
        du = shutil.disk_usage("/")
        disk_root = {"total_bytes": int(du.total), "used_bytes": int(du.used), "free_bytes": int(du.free)}
    except Exception:
        pass

    fd_count = None
    try:
        fd_count = len(os.listdir("/proc/self/fd"))
    except Exception:
        pass

    return {
        "now": _utcnow().isoformat(),
        "process": {
            "pid": int(os.getpid()),
            "uptime_s": round(time.monotonic() - _PROC_START_MONO, 3),
            "rss_bytes": rss,
            "cpu_total_s": proc_cpu_total_s,
            "open_fds": fd_count,
        }
        | cpu_delta.get("process", {}),
        "system": {
            "cpu_count": int(os.cpu_count() or 0) or None,
            "loadavg": {"1m": load1, "5m": load5, "15m": load15},
            "uptime_s": sys_uptime_s,
            "memory": {
                "total_bytes": mem_total or None,
                "available_bytes": mem_avail or None,
                "used_bytes": mem_used,
                "used_percent": round(mem_used_pct, 2) if mem_used_pct is not None else None,
            },
            "disk_root": disk_root,
        }
        | cpu_delta.get("system", {}),
        "cgroup": cgroup,
        "runtime": {"python": platform.python_version(), "platform": platform.platform()},
    }


@router.get("/workspaces/{workspace_id}/storage")
def workspace_storage(
    workspace_id: str,
    principal: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """
    返回与“容量/成本”更相关的存储指标：Postgres DB 体积与核心表/索引占用。

    注意：该指标与宿主机 macOS 的磁盘容量不是同一个口径；它用于判断数据库膨胀与清理策略（chunks/retrieval_events）。
    """

    _require_workspace_access(principal, workspace_id)
    return _get_storage_cached(db)


class AppCreateRequest(BaseModel):
    name: str
    public_model_id: str | None = None
    status: str = "published"
    config: dict[str, Any] = Field(default_factory=dict)


class AppUpdateRequest(BaseModel):
    name: str | None = None
    public_model_id: str | None = None
    status: str | None = None
    config: dict[str, Any] | None = None


class KbCreateRequest(BaseModel):
    name: str
    description: str = ""
    status: str = "active"
    config: dict[str, Any] = Field(default_factory=dict)


class KbUpdateRequest(BaseModel):
    name: str | None = None
    description: str | None = None
    status: str | None = None
    config: dict[str, Any] | None = None


class SourceCreateRequest(BaseModel):
    type: str = "crawler_site"
    name: str
    config: dict[str, Any] = Field(default_factory=dict)
    status: str = "active"


class SourceUpdateRequest(BaseModel):
    name: str | None = None
    config: dict[str, Any] | None = None
    status: str | None = None


class JobTriggerCrawlRequest(BaseModel):
    kb_id: str
    source_id: str
    mode: str = "full"
    base_url: str | None = None
    sitemap_url: str | None = None
    seed_urls: list[str] | None = None
    include_patterns: list[str] | None = None
    exclude_patterns: list[str] | None = None
    max_pages: int | None = None


class JobTriggerIndexRequest(BaseModel):
    kb_id: str
    mode: str = "incremental"


class AppKbBindingItem(BaseModel):
    kb_id: str
    weight: float = 1.0
    priority: int = 0
    enabled: bool = True


class AppKbBindingsPutRequest(BaseModel):
    bindings: list[AppKbBindingItem]

def _parse_date_range(date_range: str | None) -> tuple[dt.datetime, dt.datetime]:
    now = _utcnow()
    dr = (date_range or "").strip().lower()
    if not dr:
        return now - dt.timedelta(hours=24), now

    try:
        if dr.endswith("h"):
            hours = int(dr[:-1])
            return now - dt.timedelta(hours=max(1, hours)), now
        if dr.endswith("d"):
            days = int(dr[:-1])
            return now - dt.timedelta(days=max(1, days)), now
    except Exception:
        pass

    # 兜底：不识别则按 24h
    return now - dt.timedelta(hours=24), now


def _parse_iso_datetime(value: str | None) -> dt.datetime | None:
    """
    解析 ISO 日期/时间字符串（用于 created_from/created_to）。

    支持：
    - 2025-01-01
    - 2025-01-01T12:34:56
    - 2025-01-01T12:34:56Z
    """

    raw = (value or "").strip()
    if not raw:
        return None

    s = raw[:-1] if raw.endswith("Z") else raw
    try:
        return dt.datetime.fromisoformat(s)
    except Exception:
        pass

    try:
        d = dt.date.fromisoformat(s)
    except Exception:
        return None
    return dt.datetime.combine(d, dt.time.min)


def _estimate_cost_usd(
    pricing: dict[str, dict[str, float]],
    *,
    model: str,
    prompt_tokens: int,
    completion_tokens: int,
) -> float | None:
    m = (model or "").strip()
    if not m:
        return None
    p = pricing.get(m)
    if not p:
        return None
    pt = max(0, int(prompt_tokens or 0))
    ct = max(0, int(completion_tokens or 0))
    return (pt / 1000.0) * float(p.get("prompt_usd_per_1k", 0.0)) + (ct / 1000.0) * float(p.get("completion_usd_per_1k", 0.0))


@router.post("/auth/login", response_model=AdminLoginResponse)
def admin_login(req: AdminLoginRequest, settings: Settings = Depends(get_settings)) -> AdminLoginResponse:
    principal = authenticate_admin(username=req.username, password=req.password, settings=settings)
    token, expires_in = issue_admin_access_token(principal, settings=settings)
    return AdminLoginResponse(access_token=token, expires_in=expires_in)


@router.get("/auth/me", response_model=AdminMeResponse)
def admin_me(principal: AdminPrincipal = Depends(require_admin)) -> AdminMeResponse:
    return AdminMeResponse(username=principal.username, role=principal.role, workspace_id=principal.workspace_id)


@router.get("/workspaces", response_model=list[WorkspaceItem])
def list_workspaces(
    principal: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
) -> list[WorkspaceItem]:
    items = db.scalars(select(Workspace).order_by(Workspace.created_at.asc())).all()
    # 当前只有超管账号：返回全部 workspace；访问控制在具体 workspace 路由校验
    return [WorkspaceItem(id=w.id, name=w.name) for w in items]


@router.get("/workspaces/{workspace_id}")
def get_workspace(
    workspace_id: str,
    principal: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    _require_workspace_access(principal, workspace_id)
    w = db.get(Workspace, workspace_id)
    if not w:
        raise HTTPException(status_code=404, detail="workspace not found")
    return {"id": w.id, "name": w.name, "created_at": w.created_at.isoformat() if w.created_at else None}


@router.get("/workspaces/{workspace_id}/health", response_model=HealthResponse)
def workspace_health(
    workspace_id: str,
    settings: Settings = Depends(get_settings),
    principal: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
) -> HealthResponse:
    _require_workspace_access(principal, workspace_id)
    deps: dict[str, Any] = {"postgres": "unknown", "pgvector": "unknown", "indexes": {}}

    try:
        db.execute(text("SELECT 1")).scalar()
        deps["postgres"] = "ok"
    except Exception as e:
        deps["postgres"] = f"error: {str(e)}"

    try:
        db.execute(text("SELECT extname FROM pg_extension WHERE extname='vector'")).scalar()
        deps["pgvector"] = "ok"
    except Exception as e:
        deps["pgvector"] = f"error: {str(e)}"

    try:
        idx_rows = db.execute(text("SELECT indexname FROM pg_indexes WHERE tablename='chunks'")).scalars().all()
        idx_set = {str(n) for n in (idx_rows or [])}
        deps["indexes"] = {
            "pgvector_hnsw": "idx_chunks_embedding_hnsw" in idx_set,
            "pgvector_ivfflat": "idx_chunks_embedding_ivfflat" in idx_set,
            "fts": any(n.startswith("idx_chunks_fts_") for n in idx_set),
            "pgvector_embedding_dim": int(settings.pgvector_embedding_dim),
        }
    except Exception as e:
        deps["indexes"] = {"error": str(e)}

    ok = deps.get("postgres") == "ok" and deps.get("pgvector") == "ok"
    return HealthResponse(status=("ok" if ok else "degraded"), dependencies=deps)


@router.get("/workspaces/{workspace_id}/settings")
def workspace_settings(
    workspace_id: str,
    settings: Settings = Depends(get_settings),
    principal: AdminPrincipal = Depends(require_admin),
) -> dict[str, Any]:
    _require_workspace_access(principal, workspace_id)

    # 脱敏：不返回密码/密钥
    return {
        "app_env": settings.app_env,
        "log_level": settings.log_level,
        "database": {"url": "***"},
        "models": {
            "chat": {
                "provider": settings.chat_model_provider,
                "base_url": str(settings.chat_base_url),
                "model": settings.chat_model,
                "timeout_s": float(settings.chat_timeout_s),
                "max_retries": int(settings.chat_max_retries),
                "default_temperature": float(settings.chat_default_temperature),
                "default_top_p": float(settings.chat_default_top_p),
                "default_max_tokens": int(settings.chat_default_max_tokens),
                "max_concurrent_requests": int(settings.max_concurrent_chat_requests),
            },
            "embeddings": {
                "provider": settings.embeddings_provider,
                "sentence_transformers_model": settings.sentence_transformers_model or "",
                "ollama_base_url": str(settings.ollama_base_url),
                "ollama_embedding_model": settings.ollama_embedding_model,
                "dim": int(settings.pgvector_embedding_dim),
                "cache": {"size": int(settings.query_embed_cache_size), "ttl_s": float(settings.query_embed_cache_ttl_s)},
            },
            "rerank": {
                "provider": settings.rerank_provider,
                "bge_reranker_model": settings.bge_reranker_model,
                "device": settings.rerank_device,
                "batch_size": int(settings.rerank_batch_size),
                "max_candidates": int(settings.rerank_max_candidates),
                "max_chars": int(settings.rerank_max_chars),
            },
        },
        "retrieval": {
            "mode": settings.retrieval_mode,
            "rag_top_k": settings.rag_top_k,
            "rag_top_n": settings.rag_top_n,
            "rag_max_sources": settings.rag_max_sources,
            "bm25_fts_config": settings.bm25_fts_config,
            "hybrid_vector_weight": settings.hybrid_vector_weight,
            "hybrid_bm25_weight": settings.hybrid_bm25_weight,
        },
        "indexes": {
            "auto_create_indexes": bool(settings.auto_create_indexes),
            "pgvector_index_type": settings.pgvector_index_type,
            "pgvector_embedding_dim": int(settings.pgvector_embedding_dim),
        },
        "jobs": {"backend": settings.jobs_backend},
        "widget": {"frame_ancestors": settings.widget_frame_ancestors},
        "observability": {"retrieval_events_enabled": bool(settings.retrieval_events_enabled)},
    }


@router.get("/workspaces/{workspace_id}/summary", response_model=SummaryResponse)
def workspace_summary(
    workspace_id: str,
    principal: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
) -> SummaryResponse:
    _require_workspace_access(principal, workspace_id)
    now = _utcnow()
    since_24h = now - dt.timedelta(hours=24)

    pages_total = int(
        db.scalar(select(func.count()).select_from(Page).where(Page.workspace_id == workspace_id)) or 0
    )
    pages_failed = int(
        db.scalar(
            select(func.count())
            .select_from(Page)
            .where(Page.workspace_id == workspace_id)
            .where(Page.http_status != 200)
        )
        or 0
    )
    pages_24h = int(
        db.scalar(
            select(func.count())
            .select_from(Page)
            .where(Page.workspace_id == workspace_id)
            .where(Page.last_crawled_at >= since_24h)
        )
        or 0
    )
    last_crawl = db.scalar(select(func.max(Page.last_crawled_at)).where(Page.workspace_id == workspace_id))

    chunks_total = int(
        db.execute(
            text(
                """
                SELECT COUNT(*)
                FROM chunks c
                JOIN pages p ON p.id = c.page_id
                WHERE p.workspace_id = :ws
                """
            ),
            {"ws": workspace_id},
        ).scalar()
        or 0
    )
    chunks_with_embedding = int(
        db.execute(
            text(
                """
                SELECT COUNT(*)
                FROM chunks c
                JOIN pages p ON p.id = c.page_id
                WHERE p.workspace_id = :ws
                  AND c.embedding IS NOT NULL
                """
            ),
            {"ws": workspace_id},
        ).scalar()
        or 0
    )
    embedding_coverage = (chunks_with_embedding / chunks_total) if chunks_total > 0 else 0.0

    embedding_models_rows = db.execute(
        text(
            """
            SELECT c.embedding_model AS model, COUNT(*) AS cnt
            FROM chunks c
            JOIN pages p ON p.id = c.page_id
            WHERE p.workspace_id = :ws
            GROUP BY c.embedding_model
            ORDER BY cnt DESC
            """
        ),
        {"ws": workspace_id},
    ).all()
    embedding_models = {str(r[0] or ""): int(r[1] or 0) for r in embedding_models_rows if (r[0] or "").strip()}

    jobs_rows = db.execute(
        text(
            """
            SELECT type, status, COUNT(*) AS cnt
            FROM jobs
            WHERE workspace_id = :ws
            GROUP BY type, status
            """
        ),
        {"ws": workspace_id},
    ).all()
    jobs_by_type: dict[str, dict[str, int]] = {}
    for t, s, cnt in jobs_rows:
        jobs_by_type.setdefault(str(t), {})[str(s)] = int(cnt or 0)

    feedback_total = int(
        db.scalar(select(func.count()).select_from(Feedback).where(Feedback.workspace_id == workspace_id)) or 0
    )
    feedback_up = int(
        db.scalar(
            select(func.count())
            .select_from(Feedback)
            .where(Feedback.workspace_id == workspace_id)
            .where(Feedback.rating == "up")
        )
        or 0
    )
    feedback_down = int(
        db.scalar(
            select(func.count())
            .select_from(Feedback)
            .where(Feedback.workspace_id == workspace_id)
            .where(Feedback.rating == "down")
        )
        or 0
    )

    idx_rows = db.execute(text("SELECT indexname FROM pg_indexes WHERE tablename='chunks'")).scalars().all()
    idx_set = {str(n) for n in (idx_rows or [])}
    has_hnsw = "idx_chunks_embedding_hnsw" in idx_set
    has_ivfflat = "idx_chunks_embedding_ivfflat" in idx_set
    has_fts = any(n.startswith("idx_chunks_fts_") for n in idx_set)

    return SummaryResponse(
        pages={
            "total": pages_total,
            "failed": pages_failed,
            "last_24h": pages_24h,
            "last_crawled_at": last_crawl.isoformat() if last_crawl else None,
        },
        chunks={
            "total": chunks_total,
            "with_embedding": chunks_with_embedding,
            "embedding_coverage": embedding_coverage,
            "embedding_models": embedding_models,
        },
        jobs={"by_type": jobs_by_type},
        feedback={
            "total": feedback_total,
            "up": feedback_up,
            "down": feedback_down,
            "up_ratio": (feedback_up / feedback_total) if feedback_total > 0 else 0.0,
        },
        indexes={"pgvector_hnsw": has_hnsw, "pgvector_ivfflat": has_ivfflat, "fts": has_fts},
    )


@router.get("/workspaces/{workspace_id}/apps")
def list_apps(
    workspace_id: str,
    principal: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    _require_workspace_access(principal, workspace_id)
    kb_count_subq = (
        select(RagAppKnowledgeBase.app_id, func.count().label("kb_count"))
        .where(RagAppKnowledgeBase.workspace_id == workspace_id)
        .where(RagAppKnowledgeBase.enabled.is_(True))
        .group_by(RagAppKnowledgeBase.app_id)
        .subquery()
    )
    rows = db.execute(
        select(RagApp, func.coalesce(kb_count_subq.c.kb_count, 0))
        .where(RagApp.workspace_id == workspace_id)
        .outerjoin(kb_count_subq, kb_count_subq.c.app_id == RagApp.id)
        .order_by(RagApp.created_at.asc())
    ).all()
    return {
        "items": [
            {
                "id": app.id,
                "name": app.name,
                "public_model_id": app.public_model_id,
                "status": app.status,
                "kb_count": int(kb_count or 0),
                "created_at": app.created_at.isoformat() if app.created_at else None,
                "updated_at": app.updated_at.isoformat() if app.updated_at else None,
            }
            for app, kb_count in rows
        ]
    }


@router.post("/workspaces/{workspace_id}/apps")
def create_app(
    workspace_id: str,
    req: AppCreateRequest,
    principal: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    _require_workspace_access(principal, workspace_id)
    app_id = f"app_{uuid.uuid4().hex[:12]}"
    public_model_id = (req.public_model_id or "").strip() or f"model_{uuid.uuid4().hex[:10]}"
    now = _utcnow()
    app = RagApp(
        id=app_id,
        workspace_id=workspace_id,
        name=req.name.strip(),
        public_model_id=public_model_id,
        status=req.status,
        config=req.config or {},
        created_at=now,
        updated_at=now,
    )
    db.add(app)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=400, detail="public_model_id 已存在")
    return {"id": app.id}


@router.get("/workspaces/{workspace_id}/apps/{app_id}")
def get_app(
    workspace_id: str,
    app_id: str,
    principal: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    _require_workspace_access(principal, workspace_id)
    app = db.get(RagApp, app_id)
    if not app or app.workspace_id != workspace_id:
        raise HTTPException(status_code=404, detail="app not found")
    return {
        "id": app.id,
        "workspace_id": app.workspace_id,
        "name": app.name,
        "public_model_id": app.public_model_id,
        "status": app.status,
        "config": app.config or {},
        "created_at": app.created_at.isoformat() if app.created_at else None,
        "updated_at": app.updated_at.isoformat() if app.updated_at else None,
    }


@router.patch("/workspaces/{workspace_id}/apps/{app_id}")
def update_app(
    workspace_id: str,
    app_id: str,
    req: AppUpdateRequest,
    principal: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    _require_workspace_access(principal, workspace_id)
    app = db.get(RagApp, app_id)
    if not app or app.workspace_id != workspace_id:
        raise HTTPException(status_code=404, detail="app not found")
    if req.name is not None:
        app.name = req.name.strip()
    if req.public_model_id is not None:
        app.public_model_id = req.public_model_id.strip()
    if req.status is not None:
        app.status = req.status
    if req.config is not None:
        app.config = req.config
    app.updated_at = _utcnow()
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=400, detail="public_model_id 已存在")
    return {"ok": True}


@router.get("/workspaces/{workspace_id}/apps/{app_id}/kbs")
def get_app_kbs(
    workspace_id: str,
    app_id: str,
    principal: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    _require_workspace_access(principal, workspace_id)
    app = db.get(RagApp, app_id)
    if not app or app.workspace_id != workspace_id:
        raise HTTPException(status_code=404, detail="app not found")

    bindings = db.scalars(
        select(RagAppKnowledgeBase)
        .where(RagAppKnowledgeBase.workspace_id == workspace_id)
        .where(RagAppKnowledgeBase.app_id == app_id)
        .order_by(RagAppKnowledgeBase.priority.asc(), RagAppKnowledgeBase.id.asc())
    ).all()
    kb_ids = [b.kb_id for b in bindings]
    kb_map = {
        kb.id: kb
        for kb in db.scalars(
            select(KnowledgeBase).where(KnowledgeBase.workspace_id == workspace_id).where(KnowledgeBase.id.in_(kb_ids))
        ).all()
    }
    return {
        "items": [
            {
                "kb_id": b.kb_id,
                "kb_name": (kb_map.get(b.kb_id).name if kb_map.get(b.kb_id) else ""),
                "weight": float(b.weight or 0.0),
                "priority": int(b.priority or 0),
                "enabled": bool(b.enabled),
            }
            for b in bindings
        ]
    }


@router.put("/workspaces/{workspace_id}/apps/{app_id}/kbs")
def put_app_kbs(
    workspace_id: str,
    app_id: str,
    req: AppKbBindingsPutRequest,
    principal: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    _require_workspace_access(principal, workspace_id)
    app = db.get(RagApp, app_id)
    if not app or app.workspace_id != workspace_id:
        raise HTTPException(status_code=404, detail="app not found")

    # 校验 kb 存在且同 workspace
    kb_ids = [b.kb_id for b in req.bindings]
    if kb_ids:
        exists = set(
            db.scalars(
                select(KnowledgeBase.id).where(KnowledgeBase.workspace_id == workspace_id).where(KnowledgeBase.id.in_(kb_ids))
            ).all()
        )
        missing = [kid for kid in kb_ids if kid not in exists]
        if missing:
            raise HTTPException(status_code=400, detail=f"kb 不存在：{','.join(missing)}")

    db.execute(
        delete(RagAppKnowledgeBase)
        .where(RagAppKnowledgeBase.workspace_id == workspace_id)
        .where(RagAppKnowledgeBase.app_id == app_id)
    )
    now = _utcnow()
    for b in req.bindings:
        db.add(
            RagAppKnowledgeBase(
                workspace_id=workspace_id,
                app_id=app_id,
                kb_id=b.kb_id,
                weight=float(b.weight),
                priority=int(b.priority),
                enabled=bool(b.enabled),
                created_at=now,
            )
        )
    db.commit()
    return {"ok": True}


@router.get("/workspaces/{workspace_id}/kbs")
def list_kbs(
    workspace_id: str,
    principal: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    _require_workspace_access(principal, workspace_id)
    kbs = db.scalars(select(KnowledgeBase).where(KnowledgeBase.workspace_id == workspace_id).order_by(KnowledgeBase.created_at.asc())).all()
    return {
        "items": [
            {
                "id": kb.id,
                "name": kb.name,
                "description": kb.description,
                "status": kb.status,
                "created_at": kb.created_at.isoformat() if kb.created_at else None,
                "updated_at": kb.updated_at.isoformat() if kb.updated_at else None,
            }
            for kb in kbs
        ]
    }


@router.post("/workspaces/{workspace_id}/kbs")
def create_kb(
    workspace_id: str,
    req: KbCreateRequest,
    principal: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    _require_workspace_access(principal, workspace_id)
    kb_id = f"kb_{uuid.uuid4().hex[:12]}"
    now = _utcnow()
    kb = KnowledgeBase(
        id=kb_id,
        workspace_id=workspace_id,
        name=req.name.strip(),
        description=req.description,
        status=req.status,
        config=req.config or {},
        created_at=now,
        updated_at=now,
    )
    db.add(kb)
    db.commit()
    return {"id": kb.id}


@router.get("/workspaces/{workspace_id}/kbs/{kb_id}")
def get_kb(
    workspace_id: str,
    kb_id: str,
    principal: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    _require_workspace_access(principal, workspace_id)
    kb = db.get(KnowledgeBase, kb_id)
    if not kb or kb.workspace_id != workspace_id:
        raise HTTPException(status_code=404, detail="kb not found")
    return {
        "id": kb.id,
        "name": kb.name,
        "description": kb.description,
        "status": kb.status,
        "config": kb.config or {},
        "created_at": kb.created_at.isoformat() if kb.created_at else None,
        "updated_at": kb.updated_at.isoformat() if kb.updated_at else None,
    }


@router.get("/workspaces/{workspace_id}/kbs/{kb_id}/stats")
def kb_stats(
    workspace_id: str,
    kb_id: str,
    principal: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    _require_workspace_access(principal, workspace_id)
    kb = db.get(KnowledgeBase, kb_id)
    if not kb or kb.workspace_id != workspace_id:
        raise HTTPException(status_code=404, detail="kb not found")

    pages_total = int(
        db.scalar(
            select(func.count())
            .select_from(Page)
            .where(Page.workspace_id == workspace_id)
            .where(Page.kb_id == kb_id)
        )
        or 0
    )
    chunks_total = int(
        db.execute(
            text(
                """
                SELECT COUNT(*)
                FROM chunks c
                JOIN pages p ON p.id = c.page_id
                WHERE p.workspace_id = :ws
                  AND p.kb_id = :kb
                """
            ),
            {"ws": workspace_id, "kb": kb_id},
        ).scalar()
        or 0
    )
    chunks_with_embedding = int(
        db.execute(
            text(
                """
                SELECT COUNT(*)
                FROM chunks c
                JOIN pages p ON p.id = c.page_id
                WHERE p.workspace_id = :ws
                  AND p.kb_id = :kb
                  AND c.embedding IS NOT NULL
                """
            ),
            {"ws": workspace_id, "kb": kb_id},
        ).scalar()
        or 0
    )
    embedding_coverage = (chunks_with_embedding / chunks_total) if chunks_total > 0 else 0.0

    last_crawl = db.scalar(
        select(func.max(Page.last_crawled_at))
        .select_from(Page)
        .where(Page.workspace_id == workspace_id)
        .where(Page.kb_id == kb_id)
    )

    return {
        "kb_id": kb_id,
        "pages": {"total": pages_total, "last_crawled_at": last_crawl.isoformat() if last_crawl else None},
        "chunks": {"total": chunks_total, "with_embedding": chunks_with_embedding, "embedding_coverage": embedding_coverage},
    }


@router.patch("/workspaces/{workspace_id}/kbs/{kb_id}")
def update_kb(
    workspace_id: str,
    kb_id: str,
    req: KbUpdateRequest,
    principal: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    _require_workspace_access(principal, workspace_id)
    kb = db.get(KnowledgeBase, kb_id)
    if not kb or kb.workspace_id != workspace_id:
        raise HTTPException(status_code=404, detail="kb not found")
    if req.name is not None:
        kb.name = req.name.strip()
    if req.description is not None:
        kb.description = req.description
    if req.status is not None:
        kb.status = req.status
    if req.config is not None:
        kb.config = req.config
    kb.updated_at = _utcnow()
    db.commit()
    return {"ok": True}


@router.delete("/workspaces/{workspace_id}/kbs/{kb_id}")
def delete_kb(
    workspace_id: str,
    kb_id: str,
    principal: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    _require_workspace_access(principal, workspace_id)
    kb = db.get(KnowledgeBase, kb_id)
    if not kb or kb.workspace_id != workspace_id:
        raise HTTPException(status_code=404, detail="kb not found")

    # 删除 KB 不会自动清理 pages/chunks（历史兼容）；P1 可补齐级联与批次回滚机制
    db.delete(kb)
    db.commit()
    return {"ok": True}


@router.get("/workspaces/{workspace_id}/kbs/{kb_id}/sources")
def list_sources(
    workspace_id: str,
    kb_id: str,
    principal: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    _require_workspace_access(principal, workspace_id)
    sources = db.scalars(
        select(DataSource)
        .where(DataSource.workspace_id == workspace_id)
        .where(DataSource.kb_id == kb_id)
        .order_by(DataSource.created_at.asc())
    ).all()
    return {
        "items": [
            {
                "id": s.id,
                "type": s.type,
                "name": s.name,
                "status": s.status,
                "config": s.config or {},
                "created_at": s.created_at.isoformat() if s.created_at else None,
                "updated_at": s.updated_at.isoformat() if s.updated_at else None,
            }
            for s in sources
        ]
    }


@router.post("/workspaces/{workspace_id}/kbs/{kb_id}/sources")
def create_source(
    workspace_id: str,
    kb_id: str,
    req: SourceCreateRequest,
    principal: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    _require_workspace_access(principal, workspace_id)
    source_id = f"src_{uuid.uuid4().hex[:12]}"
    now = _utcnow()
    s = DataSource(
        id=source_id,
        workspace_id=workspace_id,
        kb_id=kb_id,
        type=req.type,
        name=req.name.strip(),
        config=req.config or {},
        status=req.status,
        created_at=now,
        updated_at=now,
    )
    db.add(s)
    db.commit()
    return {"id": s.id}


@router.patch("/workspaces/{workspace_id}/kbs/{kb_id}/sources/{source_id}")
def update_source(
    workspace_id: str,
    kb_id: str,
    source_id: str,
    req: SourceUpdateRequest,
    principal: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    _require_workspace_access(principal, workspace_id)
    s = db.get(DataSource, source_id)
    if not s or s.workspace_id != workspace_id or s.kb_id != kb_id:
        raise HTTPException(status_code=404, detail="source not found")
    if req.name is not None:
        s.name = req.name.strip()
    if req.status is not None:
        s.status = req.status
    if req.config is not None:
        s.config = req.config
    s.updated_at = _utcnow()
    db.commit()
    return {"ok": True}


@router.delete("/workspaces/{workspace_id}/kbs/{kb_id}/sources/{source_id}")
def delete_source(
    workspace_id: str,
    kb_id: str,
    source_id: str,
    principal: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    _require_workspace_access(principal, workspace_id)
    s = db.get(DataSource, source_id)
    if not s or s.workspace_id != workspace_id or s.kb_id != kb_id:
        raise HTTPException(status_code=404, detail="source not found")
    db.delete(s)
    db.commit()
    return {"ok": True}


@router.get("/workspaces/{workspace_id}/jobs")
def list_jobs(
    workspace_id: str,
    type: str | None = None,  # noqa: A002
    status: str | None = None,
    kb_id: str | None = None,
    app_id: str | None = None,
    source_id: str | None = None,
    q: str | None = None,
    created_from: str | None = None,
    created_to: str | None = None,
    page: int = 1,
    page_size: int = 20,
    principal: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    _require_workspace_access(principal, workspace_id)
    p, ps, offset = _parse_pagination(page, page_size)

    stmt = select(Job).where(Job.workspace_id == workspace_id)
    if type:
        stmt = stmt.where(Job.type == type)
    if status:
        stmt = stmt.where(Job.status == status)
    if kb_id:
        stmt = stmt.where(Job.kb_id == kb_id)
    if app_id:
        stmt = stmt.where(Job.app_id == app_id)
    if source_id:
        stmt = stmt.where(Job.source_id == source_id)

    q_from = _parse_iso_datetime(created_from)
    if q_from is not None:
        stmt = stmt.where(Job.started_at >= q_from)
    q_to = _parse_iso_datetime(created_to)
    if q_to is not None:
        # 约定：若传入的是“日期”（YYYY-MM-DD），按当天结束做包含（+1d 作为上界）
        if (created_to or "").strip() and len((created_to or "").strip()) == 10:
            q_to = q_to + dt.timedelta(days=1)
            stmt = stmt.where(Job.started_at < q_to)
        else:
            stmt = stmt.where(Job.started_at <= q_to)

    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(Job.id.ilike(like) | Job.error.ilike(like))

    total = int(db.scalar(select(func.count()).select_from(stmt.subquery())) or 0)
    rows = db.scalars(stmt.order_by(desc(Job.started_at)).offset(offset).limit(ps)).all()
    return {
        "page": p,
        "page_size": ps,
        "total": total,
        "items": [
            {
                "id": j.id,
                "type": j.type,
                "status": j.status,
                "kb_id": j.kb_id,
                "app_id": j.app_id,
                "source_id": j.source_id,
                "progress": j.progress or {},
                "error": j.error or "",
                "started_at": j.started_at.isoformat() if j.started_at else None,
                "finished_at": j.finished_at.isoformat() if j.finished_at else None,
            }
            for j in rows
        ],
    }


@router.get("/workspaces/{workspace_id}/jobs/{job_id}")
def get_job(
    workspace_id: str,
    job_id: str,
    principal: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    _require_workspace_access(principal, workspace_id)
    job = db.get(Job, job_id)
    if not job or job.workspace_id != workspace_id:
        raise HTTPException(status_code=404, detail="job not found")
    return {
        "id": job.id,
        "type": job.type,
        "status": job.status,
        "workspace_id": job.workspace_id,
        "kb_id": job.kb_id,
        "app_id": job.app_id,
        "source_id": job.source_id,
        "payload": job.payload or {},
        "progress": job.progress or {},
        "error": job.error or "",
        "started_at": job.started_at.isoformat() if job.started_at else None,
        "finished_at": job.finished_at.isoformat() if job.finished_at else None,
    }


@router.post("/workspaces/{workspace_id}/jobs/{job_id}/requeue")
def requeue_job(
    workspace_id: str,
    job_id: str,
    principal: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    _require_workspace_access(principal, workspace_id)
    job = db.get(Job, job_id)
    if not job or job.workspace_id != workspace_id:
        raise HTTPException(status_code=404, detail="job not found")
    job.status = "queued"
    job.error = ""
    job.progress = {}
    job.started_at = _utcnow()
    job.finished_at = None
    db.commit()
    return {"ok": True}


@router.post("/workspaces/{workspace_id}/jobs/{job_id}/cancel")
def cancel_job(
    workspace_id: str,
    job_id: str,
    principal: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    _require_workspace_access(principal, workspace_id)
    job = db.get(Job, job_id)
    if not job or job.workspace_id != workspace_id:
        raise HTTPException(status_code=404, detail="job not found")
    if job.status != "queued":
        raise HTTPException(status_code=400, detail="仅支持取消 queued 状态任务（running 暂不支持中断）")
    job.status = "cancelled"
    job.finished_at = _utcnow()
    db.commit()
    return {"ok": True}


@router.post("/workspaces/{workspace_id}/jobs/crawl")
def trigger_crawl_job(
    workspace_id: str,
    req: JobTriggerCrawlRequest,
    settings: Settings = Depends(get_settings),
    principal: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    _require_workspace_access(principal, workspace_id)
    src = db.get(DataSource, req.source_id)
    if not src or src.workspace_id != workspace_id or src.kb_id != req.kb_id:
        raise HTTPException(status_code=404, detail="source not found")

    jobs_backend = (settings.jobs_backend or "worker").lower()
    job_id = f"crawl_{uuid.uuid4().hex[:12]}"
    payload = dict(src.config or {})
    if req.base_url is not None:
        payload["base_url"] = req.base_url
    if req.sitemap_url is not None:
        payload["sitemap_url"] = req.sitemap_url
    if req.seed_urls is not None:
        payload["seed_urls"] = req.seed_urls
    if req.include_patterns is not None:
        payload["include_patterns"] = req.include_patterns
    if req.exclude_patterns is not None:
        payload["exclude_patterns"] = req.exclude_patterns
    if req.max_pages is not None:
        payload["max_pages"] = int(req.max_pages)

    payload["workspace_id"] = workspace_id
    payload["kb_id"] = req.kb_id
    payload["source_id"] = req.source_id
    payload["mode"] = req.mode
    job = Job(
        id=job_id,
        workspace_id=workspace_id,
        kb_id=req.kb_id,
        source_id=req.source_id,
        type="crawl",
        status=("queued" if jobs_backend == "worker" else "running"),
        payload=payload,
        progress={},
    )
    db.add(job)
    db.commit()
    return {"job_id": job_id}


@router.post("/workspaces/{workspace_id}/jobs/index")
def trigger_index_job(
    workspace_id: str,
    req: JobTriggerIndexRequest,
    settings: Settings = Depends(get_settings),
    principal: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    _require_workspace_access(principal, workspace_id)
    kb = db.get(KnowledgeBase, req.kb_id)
    if not kb or kb.workspace_id != workspace_id:
        raise HTTPException(status_code=404, detail="kb not found")

    jobs_backend = (settings.jobs_backend or "worker").lower()
    job_id = f"index_{uuid.uuid4().hex[:12]}"
    payload = {"workspace_id": workspace_id, "kb_id": req.kb_id, "mode": req.mode}
    job = Job(
        id=job_id,
        workspace_id=workspace_id,
        kb_id=req.kb_id,
        type="index",
        status=("queued" if jobs_backend == "worker" else "running"),
        payload=payload,
        progress={},
    )
    db.add(job)
    db.commit()
    return {"job_id": job_id}


@router.get("/workspaces/{workspace_id}/pages")
def list_pages(
    workspace_id: str,
    kb_id: str | None = None,
    source_id: str | None = None,
    q: str | None = None,
    http_status: int | None = None,
    changed: bool | None = None,
    indexed: bool | None = None,
    page: int = 1,
    page_size: int = 20,
    principal: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    _require_workspace_access(principal, workspace_id)
    p, ps, offset = _parse_pagination(page, page_size)

    stmt = select(Page).where(Page.workspace_id == workspace_id)
    if kb_id:
        stmt = stmt.where(Page.kb_id == kb_id)
    if source_id:
        stmt = stmt.where(Page.source_id == source_id)
    if http_status is not None:
        stmt = stmt.where(Page.http_status == int(http_status))
    if changed is True:
        stmt = stmt.where(Page.content_hash != Page.indexed_content_hash)
    if indexed is True:
        stmt = stmt.where(Page.indexed_content_hash != "")
    if indexed is False:
        stmt = stmt.where(Page.indexed_content_hash == "")
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(Page.url.ilike(like) | Page.title.ilike(like))

    total = int(db.scalar(select(func.count()).select_from(stmt.subquery())) or 0)
    rows = db.scalars(stmt.order_by(desc(Page.last_crawled_at)).offset(offset).limit(ps)).all()
    return {
        "page": p,
        "page_size": ps,
        "total": total,
        "items": [
            {
                "id": r.id,
                "kb_id": r.kb_id,
                "source_id": r.source_id,
                "url": r.url,
                "title": r.title,
                "http_status": r.http_status,
                "last_crawled_at": r.last_crawled_at.isoformat() if r.last_crawled_at else None,
                "indexed": bool(r.indexed_content_hash),
                "changed": bool(r.content_hash and r.content_hash != (r.indexed_content_hash or "")),
            }
            for r in rows
        ],
    }


@router.get("/workspaces/{workspace_id}/pages/{page_id}")
def get_page(
    workspace_id: str,
    page_id: int,
    principal: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    _require_workspace_access(principal, workspace_id)
    page = db.get(Page, int(page_id))
    if not page or page.workspace_id != workspace_id:
        raise HTTPException(status_code=404, detail="page not found")

    chunk_total = int(db.scalar(select(func.count()).select_from(Chunk).where(Chunk.page_id == page.id)) or 0)
    chunk_with_embedding = int(
        db.scalar(
            select(func.count()).select_from(Chunk).where(Chunk.page_id == page.id).where(Chunk.embedding.is_not(None))
        )
        or 0
    )
    model_rows = db.execute(
        select(Chunk.embedding_model, func.count())
        .where(Chunk.page_id == page.id)
        .group_by(Chunk.embedding_model)
        .order_by(desc(func.count()))
    ).all()
    embedding_models = {str(m or ""): int(c or 0) for m, c in model_rows if str(m or "").strip()}

    return {
        "id": page.id,
        "kb_id": page.kb_id,
        "source_id": page.source_id,
        "url": page.url,
        "title": page.title,
        "http_status": page.http_status,
        "last_crawled_at": page.last_crawled_at.isoformat() if page.last_crawled_at else None,
        "content_markdown": page.content_markdown,
        "chunk_stats": {
            "total": chunk_total,
            "with_embedding": chunk_with_embedding,
            "embedding_coverage": (float(chunk_with_embedding) / float(chunk_total)) if chunk_total else 0.0,
            "embedding_models": embedding_models,
        },
        "meta": page.meta or {},
    }


@router.post("/workspaces/{workspace_id}/pages/{page_id}/recrawl")
def recrawl_page(
    workspace_id: str,
    page_id: int,
    settings: Settings = Depends(get_settings),
    principal: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    _require_workspace_access(principal, workspace_id)
    page = db.get(Page, int(page_id))
    if not page or page.workspace_id != workspace_id:
        raise HTTPException(status_code=404, detail="page not found")

    jobs_backend = (settings.jobs_backend or "worker").lower()
    job_id = f"crawl_{uuid.uuid4().hex[:12]}"
    payload = {
        "workspace_id": workspace_id,
        "kb_id": page.kb_id,
        "source_id": page.source_id,
        "mode": "incremental",
        "base_url": page.url.rsplit("/", 1)[0] + "/",
        "sitemap_url": "",
        "seed_urls": [page.url],
        "include_patterns": [],
        "exclude_patterns": [],
        "max_pages": 1,
    }
    job = Job(
        id=job_id,
        workspace_id=workspace_id,
        kb_id=page.kb_id,
        source_id=page.source_id,
        type="crawl",
        status=("queued" if jobs_backend == "worker" else "running"),
        payload=payload,
        progress={},
    )
    db.add(job)
    db.commit()
    return {"job_id": job_id}


@router.delete("/workspaces/{workspace_id}/pages/{page_id}")
def delete_page(
    workspace_id: str,
    page_id: int,
    principal: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    _require_workspace_access(principal, workspace_id)
    page = db.get(Page, int(page_id))
    if not page or page.workspace_id != workspace_id:
        raise HTTPException(status_code=404, detail="page not found")
    db.delete(page)
    db.commit()
    return {"ok": True}


@router.get("/workspaces/{workspace_id}/feedback")
def list_feedback(
    workspace_id: str,
    app_id: str | None = None,
    rating: str | None = None,
    reason: str | None = None,
    date_range: str | None = None,
    page: int = 1,
    page_size: int = 20,
    principal: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    _require_workspace_access(principal, workspace_id)
    p, ps, offset = _parse_pagination(page, page_size)

    stmt = select(Feedback).where(Feedback.workspace_id == workspace_id)
    if app_id:
        stmt = stmt.where(Feedback.app_id == app_id)
    if rating:
        stmt = stmt.where(Feedback.rating == rating)
    if reason:
        stmt = stmt.where(Feedback.reason == reason)

    dr_from, dr_to = _parse_date_range(date_range)
    stmt = stmt.where(Feedback.created_at >= dr_from).where(Feedback.created_at <= dr_to)

    total = int(db.scalar(select(func.count()).select_from(stmt.subquery())) or 0)
    rows = db.scalars(stmt.order_by(desc(Feedback.created_at)).offset(offset).limit(ps)).all()
    return {
        "page": p,
        "page_size": ps,
        "total": total,
        "items": [
            {
                "id": f.id,
                "app_id": f.app_id,
                "conversation_id": f.conversation_id,
                "message_id": f.message_id,
                "rating": f.rating,
                "reason": f.reason,
                "comment": f.comment,
                "sources": f.sources or {},
                "created_at": f.created_at.isoformat() if f.created_at else None,
            }
            for f in rows
        ],
    }


@router.get("/workspaces/{workspace_id}/retrieval-events")
def list_retrieval_events(
    workspace_id: str,
    app_id: str | None = None,
    kb_id: str | None = None,
    conversation_id: str | None = None,
    request_id: str | None = None,
    has_error: bool | None = None,
    date_range: str | None = None,
    page: int = 1,
    page_size: int = 20,
    principal: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    _require_workspace_access(principal, workspace_id)
    p, ps, offset = _parse_pagination(page, page_size)

    stmt = select(RetrievalEvent).where(RetrievalEvent.workspace_id == workspace_id)
    if app_id:
        stmt = stmt.where(RetrievalEvent.app_id == app_id)
    if kb_id:
        stmt = stmt.where(text("kb_ids::jsonb ? :kb")).params(kb=kb_id)
    if conversation_id:
        stmt = stmt.where(RetrievalEvent.conversation_id == conversation_id)
    if request_id:
        stmt = stmt.where(RetrievalEvent.request_id == request_id)
    if has_error is True:
        stmt = stmt.where(RetrievalEvent.error != "")
    if has_error is False:
        stmt = stmt.where(RetrievalEvent.error == "")

    dr_from, dr_to = _parse_date_range(date_range)
    stmt = stmt.where(RetrievalEvent.created_at >= dr_from).where(RetrievalEvent.created_at <= dr_to)

    total = int(db.scalar(select(func.count()).select_from(stmt.subquery())) or 0)
    rows = db.scalars(stmt.order_by(desc(RetrievalEvent.created_at)).offset(offset).limit(ps)).all()
    return {
        "page": p,
        "page_size": ps,
        "total": total,
        "items": [
            {
                "id": e.id,
                "app_id": e.app_id,
                "kb_ids": e.kb_ids,
                "request_id": e.request_id,
                "conversation_id": e.conversation_id,
                "message_id": e.message_id,
                "timings_ms": e.timings_ms,
                "created_at": e.created_at.isoformat() if e.created_at else None,
                "has_error": bool(e.error),
            }
            for e in rows
        ],
    }


@router.get("/workspaces/{workspace_id}/retrieval-events/{event_id}")
def get_retrieval_event(
    workspace_id: str,
    event_id: int,
    principal: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    _require_workspace_access(principal, workspace_id)
    e = db.get(RetrievalEvent, int(event_id))
    if not e or e.workspace_id != workspace_id:
        raise HTTPException(status_code=404, detail="event not found")
    return {
        "id": e.id,
        "app_id": e.app_id,
        "kb_ids": e.kb_ids,
        "request_id": e.request_id,
        "conversation_id": e.conversation_id,
        "message_id": e.message_id,
        "question_sha256": e.question_sha256,
        "question_len": e.question_len,
        "retrieval_query_sha256": e.retrieval_query_sha256,
        "retrieval_query_len": e.retrieval_query_len,
        "timings_ms": e.timings_ms,
        "retrieval": e.retrieval,
        "sources": e.sources,
        "token_usage": e.token_usage,
        "error": e.error,
        "created_at": e.created_at.isoformat() if e.created_at else None,
    }


@router.get("/workspaces/{workspace_id}/observability/summary")
def observability_summary(
    workspace_id: str,
    date_range: str | None = "24h",
    settings: Settings = Depends(get_settings),
    principal: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """
    质量/可观测聚合指标（内部运维看板用）：
    - 按 app/kb 聚合请求量、错误率、命中率、topK、延迟分解、token 与成本估算
    """

    _require_workspace_access(principal, workspace_id)
    start, end = _parse_date_range(date_range)

    # overall 聚合
    overall = db.execute(
        text(
            """
            SELECT
              COUNT(*)::bigint AS requests,
              SUM(CASE WHEN error <> '' THEN 1 ELSE 0 END)::bigint AS errors,
              SUM(CASE WHEN json_typeof(sources->'items')='array' AND json_array_length(sources->'items')>0 THEN 1 ELSE 0 END)::bigint AS hits,
              AVG(NULLIF((timings_ms->>'total_prepare')::double precision, 0)) AS avg_prepare_ms,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY (timings_ms->>'total_prepare')::double precision) AS p50_prepare_ms,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY (timings_ms->>'total_prepare')::double precision) AS p95_prepare_ms,
              AVG((timings_ms->>'embed')::double precision) AS avg_embed_ms,
              AVG((timings_ms->>'retrieve')::double precision) AS avg_retrieve_ms,
              AVG((timings_ms->>'rerank')::double precision) AS avg_rerank_ms,
              AVG((timings_ms->>'context')::double precision) AS avg_context_ms,
              AVG((timings_ms->>'chat')::double precision) AS avg_chat_ms,
              AVG((timings_ms->>'total')::double precision) AS avg_total_ms,
              AVG(COALESCE((retrieval->>'retrieved')::double precision, 0)) AS avg_retrieved,
              AVG(
                CASE
                  WHEN json_typeof(retrieval->'top_chunk_ids')='array' THEN json_array_length(retrieval->'top_chunk_ids')
                  ELSE 0
                END
              ) AS avg_topn,
              SUM(COALESCE((token_usage->>'prompt_tokens')::bigint, 0)) AS prompt_tokens,
              SUM(COALESCE((token_usage->>'completion_tokens')::bigint, 0)) AS completion_tokens,
              SUM(COALESCE((token_usage->>'total_tokens')::bigint, 0)) AS total_tokens
            FROM retrieval_events
            WHERE workspace_id = :ws
              AND created_at >= :start
              AND created_at < :end
            """
        ),
        {"ws": workspace_id, "start": start, "end": end},
    ).mappings().first() or {}

    # 按 app 聚合
    by_app = db.execute(
        text(
            """
            SELECT
              app_id,
              COUNT(*)::bigint AS requests,
              SUM(CASE WHEN error <> '' THEN 1 ELSE 0 END)::bigint AS errors,
              SUM(CASE WHEN json_typeof(sources->'items')='array' AND json_array_length(sources->'items')>0 THEN 1 ELSE 0 END)::bigint AS hits,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY (timings_ms->>'total_prepare')::double precision) AS p95_prepare_ms,
              AVG((timings_ms->>'total_prepare')::double precision) AS avg_prepare_ms,
              AVG((timings_ms->>'retrieve')::double precision) AS avg_retrieve_ms,
              AVG(COALESCE((retrieval->>'retrieved')::double precision, 0)) AS avg_retrieved,
              SUM(COALESCE((token_usage->>'total_tokens')::bigint, 0)) AS total_tokens
            FROM retrieval_events
            WHERE workspace_id = :ws
              AND created_at >= :start
              AND created_at < :end
            GROUP BY app_id
            ORDER BY requests DESC
            LIMIT 200
            """
        ),
        {"ws": workspace_id, "start": start, "end": end},
    ).mappings().all()

    # 按 app + kb 聚合（kb_ids 可能为空，兜底填 (none)）
    by_app_kb = db.execute(
        text(
            """
            WITH ev AS (
              SELECT
                app_id,
                kb_ids,
                error,
                timings_ms,
                retrieval,
                sources,
                token_usage
              FROM retrieval_events
              WHERE workspace_id = :ws
                AND created_at >= :start
                AND created_at < :end
            )
            SELECT
              ev.app_id,
              k.kb_id,
              COUNT(*)::bigint AS requests,
              SUM(CASE WHEN ev.error <> '' THEN 1 ELSE 0 END)::bigint AS errors,
              SUM(CASE WHEN json_typeof(ev.sources->'items')='array' AND json_array_length(ev.sources->'items')>0 THEN 1 ELSE 0 END)::bigint AS hits,
              AVG((ev.timings_ms->>'total_prepare')::double precision) AS avg_prepare_ms,
              AVG((ev.timings_ms->>'retrieve')::double precision) AS avg_retrieve_ms,
              AVG(COALESCE((ev.retrieval->>'retrieved')::double precision, 0)) AS avg_retrieved,
              SUM(COALESCE((ev.token_usage->>'total_tokens')::bigint, 0)) AS total_tokens
            FROM ev
            CROSS JOIN LATERAL (
              SELECT value AS kb_id
              FROM jsonb_array_elements_text(
                CASE
                  WHEN jsonb_typeof(ev.kb_ids::jsonb)='array' AND jsonb_array_length(ev.kb_ids::jsonb)>0 THEN ev.kb_ids::jsonb
                  ELSE '["(none)"]'::jsonb
                END
              )
            ) AS k
            GROUP BY ev.app_id, k.kb_id
            ORDER BY requests DESC
            LIMIT 500
            """
        ),
        {"ws": workspace_id, "start": start, "end": end},
    ).mappings().all()

    # 错误码聚合（只看 error 前缀）
    errors = db.execute(
        text(
            """
            SELECT
              CASE
                WHEN error = '' THEN 'ok'
                WHEN position(':' in error) > 0 THEN split_part(error, ':', 1)
                ELSE error
              END AS code,
              COUNT(*)::bigint AS cnt
            FROM retrieval_events
            WHERE workspace_id = :ws
              AND created_at >= :start
              AND created_at < :end
            GROUP BY code
            ORDER BY cnt DESC
            LIMIT 50
            """
        ),
        {"ws": workspace_id, "start": start, "end": end},
    ).mappings().all()

    # topK（retrieved）分布（前 30 个 bucket）
    topk = db.execute(
        text(
            """
            SELECT
              COALESCE((retrieval->>'retrieved')::int, 0) AS retrieved,
              COUNT(*)::bigint AS cnt
            FROM retrieval_events
            WHERE workspace_id = :ws
              AND created_at >= :start
              AND created_at < :end
            GROUP BY retrieved
            ORDER BY retrieved ASC
            LIMIT 30
            """
        ),
        {"ws": workspace_id, "start": start, "end": end},
    ).mappings().all()

    # token/cost：按上游模型聚合（依赖 meta 注入 upstream_chat_model）
    pricing = settings.model_pricing()
    tokens_by_model_rows = db.execute(
        text(
            """
            SELECT
              COALESCE(retrieval->>'upstream_chat_model', '') AS model,
              COUNT(*)::bigint AS requests,
              SUM(COALESCE((token_usage->>'prompt_tokens')::bigint, 0)) AS prompt_tokens,
              SUM(COALESCE((token_usage->>'completion_tokens')::bigint, 0)) AS completion_tokens,
              SUM(COALESCE((token_usage->>'total_tokens')::bigint, 0)) AS total_tokens
            FROM retrieval_events
            WHERE workspace_id = :ws
              AND created_at >= :start
              AND created_at < :end
            GROUP BY model
            ORDER BY total_tokens DESC
            LIMIT 50
            """
        ),
        {"ws": workspace_id, "start": start, "end": end},
    ).mappings().all()

    tokens_by_model: list[dict[str, Any]] = []
    for r in tokens_by_model_rows:
        m = str(r.get("model") or "")
        pt = int(r.get("prompt_tokens") or 0)
        ct = int(r.get("completion_tokens") or 0)
        tokens_by_model.append(
            {
                **dict(r),
                "cost_usd_estimate": _estimate_cost_usd(pricing, model=m, prompt_tokens=pt, completion_tokens=ct),
            }
        )

    # rerank 效果（抽样）：top_scores（可能为 rerank 后）与 top_scores_pre_rerank（召回原始分）差值
    rerank_rows = db.execute(
        text(
            """
            SELECT
              retrieval->'top_scores_pre_rerank' AS pre,
              retrieval->'top_scores' AS post
            FROM retrieval_events
            WHERE workspace_id = :ws
              AND created_at >= :start
              AND created_at < :end
              AND COALESCE(retrieval->>'rerank_used','false') = 'true'
            ORDER BY id DESC
            LIMIT 500
            """
        ),
        {"ws": workspace_id, "start": start, "end": end},
    ).all()

    deltas: list[float] = []
    for pre, post in rerank_rows or []:
        if not isinstance(pre, list) or not isinstance(post, list):
            continue
        n = min(len(pre), len(post))
        for i in range(n):
            a = pre[i]
            b = post[i]
            if isinstance(a, (int, float)) and isinstance(b, (int, float)):
                deltas.append(float(b) - float(a))
    rerank_effect = {
        "sample_events": int(len(rerank_rows or [])),
        "sample_pairs": int(len(deltas)),
        "avg_delta": (sum(deltas) / len(deltas)) if deltas else None,
    }

    def _ratio(n: int, d: int) -> float:
        return (float(n) / float(d)) if d else 0.0

    overall_requests = int(overall.get("requests") or 0)
    overall_errors = int(overall.get("errors") or 0)
    overall_hits = int(overall.get("hits") or 0)

    return {
        "from": start.isoformat(),
        "to": end.isoformat(),
        "overall": {
            **dict(overall),
            "error_ratio": _ratio(overall_errors, overall_requests),
            "hit_ratio": _ratio(overall_hits, overall_requests),
        },
        "by_app": [
            {
                **dict(r),
                "error_ratio": _ratio(int(r.get("errors") or 0), int(r.get("requests") or 0)),
                "hit_ratio": _ratio(int(r.get("hits") or 0), int(r.get("requests") or 0)),
            }
            for r in by_app
        ],
        "by_app_kb": [
            {
                **dict(r),
                "error_ratio": _ratio(int(r.get("errors") or 0), int(r.get("requests") or 0)),
                "hit_ratio": _ratio(int(r.get("hits") or 0), int(r.get("requests") or 0)),
            }
            for r in by_app_kb
        ],
        "errors": [dict(r) for r in errors],
        "topk": [dict(r) for r in topk],
        "tokens_by_model": tokens_by_model,
        "rerank_effect": rerank_effect,
        "pricing_configured": bool(pricing),
    }


@router.get("/workspaces/{workspace_id}/alerts")
def list_alerts(
    workspace_id: str,
    date_range: str | None = "24h",
    principal: AdminPrincipal = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """
    轻量级告警：按规则实时计算（不做持久化）。
    """

    _require_workspace_access(principal, workspace_id)
    start, end = _parse_date_range(date_range)
    alerts: list[dict[str, Any]] = []

    # 任务失败
    failed_jobs = int(
        db.scalar(
            select(func.count())
            .select_from(Job)
            .where(Job.workspace_id == workspace_id)
            .where(Job.status == "failed")
            .where(Job.started_at >= start)
            .where(Job.started_at < end)
        )
        or 0
    )
    if failed_jobs > 0:
        alerts.append(
            {
                "severity": "warning" if failed_jobs < 5 else "critical",
                "code": "jobs_failed",
                "title": "任务失败",
                "detail": f"{failed_jobs} 个任务在时间范围内失败",
                "value": failed_jobs,
            }
        )

    # 检索错误率
    total_ev = int(
        db.scalar(
            select(func.count())
            .select_from(RetrievalEvent)
            .where(RetrievalEvent.workspace_id == workspace_id)
            .where(RetrievalEvent.created_at >= start)
            .where(RetrievalEvent.created_at < end)
        )
        or 0
    )
    error_ev = int(
        db.scalar(
            select(func.count())
            .select_from(RetrievalEvent)
            .where(RetrievalEvent.workspace_id == workspace_id)
            .where(RetrievalEvent.created_at >= start)
            .where(RetrievalEvent.created_at < end)
            .where(RetrievalEvent.error != "")
        )
        or 0
    )
    if total_ev > 0:
        ratio = float(error_ev) / float(total_ev)
        if ratio >= 0.1:
            sev = "critical"
        elif ratio >= 0.02:
            sev = "warning"
        else:
            sev = ""
        if sev:
            alerts.append(
                {
                    "severity": sev,
                    "code": "retrieval_error_ratio",
                    "title": "检索链路错误率偏高",
                    "detail": f"error={error_ev}/{total_ev} ({ratio:.1%})",
                    "value": ratio,
                }
            )

    # embedding 覆盖率（全 workspace 粗略）
    chunks_total = int(
        db.execute(
            text(
                """
                SELECT COUNT(*)
                FROM chunks c
                JOIN pages p ON p.id = c.page_id
                WHERE p.workspace_id = :ws
                """
            ),
            {"ws": workspace_id},
        ).scalar()
        or 0
    )
    chunks_with_embedding = int(
        db.execute(
            text(
                """
                SELECT COUNT(*)
                FROM chunks c
                JOIN pages p ON p.id = c.page_id
                WHERE p.workspace_id = :ws
                  AND c.embedding IS NOT NULL
                """
            ),
            {"ws": workspace_id},
        ).scalar()
        or 0
    )
    if chunks_total > 0:
        cov = chunks_with_embedding / chunks_total
        if cov < 0.6:
            alerts.append(
                {
                    "severity": "warning",
                    "code": "embedding_coverage_low",
                    "title": "Embedding 覆盖率偏低",
                    "detail": f"{chunks_with_embedding}/{chunks_total} ({cov:.1%})",
                    "value": cov,
                }
            )

    return {"from": start.isoformat(), "to": end.isoformat(), "items": alerts}
