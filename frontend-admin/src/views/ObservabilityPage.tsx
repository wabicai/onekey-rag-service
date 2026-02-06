import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";

import { Button } from "../components/ui/button";
import { DebouncedInput } from "../components/DebouncedInput";
import { Select } from "../components/ui/select";
import { Card } from "../components/Card";
import { Loading } from "../components/Loading";
import { Pagination } from "../components/Pagination";
import { EmptyState } from "../components/EmptyState";
import { ApiErrorBanner } from "../components/ApiErrorBanner";
import { FilterChips, type FilterChip } from "../components/FilterChips";
import { EntityLinksBar } from "../components/EntityLinksBar";
import { TraceLink } from "../components/TraceLink";
import { apiFetch } from "../lib/api";
import { useWorkspace } from "../lib/workspace";
import { Line, LineChart, Tooltip, XAxis, YAxis, ResponsiveContainer, CartesianGrid } from "recharts";

type RetrievalEventsResp = {
  page: number;
  page_size: number;
  total: number;
  items: Array<{
    id: number;
    app_id: string;
    kb_ids: string[];
    request_id: string;
    conversation_id: string;
    message_id: string;
    timings_ms: Record<string, unknown>;
    created_at: string | null;
    has_error: boolean;
    error_code: string;
  }>;
};

type MetricsResp = {
  date_range: string;
  degraded: boolean;
  container: Record<string, unknown>;
  net?: Record<string, unknown> | null;
  disk?: Record<string, unknown> | null;
  host?: Record<string, unknown> | null;
  timeseries?: Array<{
    ts: string;
    cpu_percent?: number | null;
    mem_used_pct?: number | null;
    net_rx_bytes?: number | null;
    net_tx_bytes?: number | null;
    disk_read_bytes?: number | null;
    disk_write_bytes?: number | null;
  }>;
};

function pickNumber(obj: Record<string, unknown> | undefined, key: string): number | null {
  if (!obj) return null;
  const v = obj[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function ObservabilityPage() {
  const { workspaceId } = useWorkspace();
  const [sp, setSp] = useSearchParams();

  const pageSize = 20;
  const page = Math.max(1, Number.parseInt(sp.get("page") || "1", 10) || 1);
  const appId = (sp.get("app_id") || "").trim();
  const kbId = (sp.get("kb_id") || "").trim();
  const conversationId = (sp.get("conversation_id") || "").trim();
  const messageId = (sp.get("message_id") || "").trim();
  const requestId = (sp.get("request_id") || "").trim();
  const errorCode = (sp.get("error_code") || "").trim();
  const hasError = (sp.get("has_error") || "").trim(); // "", "true", "false"
  const dateRange = (sp.get("date_range") || "24h").trim() || "24h";
  const metricsRange = (sp.get("metrics_range") || "24h").trim() || "24h";

  function updateFilter(nextKV: Array<[string, string | null]>) {
    const next = new URLSearchParams(sp);
    next.set("page", "1");
    for (const [k, v] of nextKV) {
      const vv = (v || "").trim();
      if (!vv) next.delete(k);
      else next.set(k, vv);
    }
    setSp(next, { replace: true });
  }

  const chips: FilterChip[] = [
    appId ? { key: "app_id", label: "应用", value: appId, onRemove: () => updateFilter([["app_id", null]]) } : null,
    kbId ? { key: "kb_id", label: "知识库", value: kbId, onRemove: () => updateFilter([["kb_id", null]]) } : null,
    conversationId
      ? { key: "conversation_id", label: "会话", value: conversationId, onRemove: () => updateFilter([["conversation_id", null]]) }
      : null,
    messageId ? { key: "message_id", label: "消息", value: messageId, onRemove: () => updateFilter([["message_id", null]]) } : null,
    requestId ? { key: "request_id", label: "请求", value: requestId, onRemove: () => updateFilter([["request_id", null]]) } : null,
    errorCode ? { key: "error_code", label: "错误码", value: errorCode, onRemove: () => updateFilter([["error_code", null]]) } : null,
    hasError ? { key: "has_error", label: "有错误", value: hasError === "true" ? "是" : "否", onRemove: () => updateFilter([["has_error", null]]) } : null,
    dateRange && dateRange !== "24h"
      ? { key: "date_range", label: "时间", value: dateRange, onRemove: () => updateFilter([["date_range", "24h"]]) }
      : null,
  ].filter(Boolean) as FilterChip[];

  const list = useQuery({
    queryKey: ["retrieval-events", workspaceId, page, pageSize, appId, kbId, conversationId, messageId, requestId, errorCode, hasError, dateRange],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("page_size", String(pageSize));
      if (appId) params.set("app_id", appId);
      if (kbId) params.set("kb_id", kbId);
      if (conversationId) params.set("conversation_id", conversationId);
      if (messageId) params.set("message_id", messageId);
      if (requestId) params.set("request_id", requestId);
      if (errorCode) params.set("error_code", errorCode);
      if (hasError === "true") params.set("has_error", "true");
      if (hasError === "false") params.set("has_error", "false");
      if (dateRange) params.set("date_range", dateRange);
      return apiFetch<RetrievalEventsResp>(`/admin/api/workspaces/${workspaceId}/retrieval-events?${params.toString()}`);
    },
    enabled: !!workspaceId,
  });

  const metrics = useQuery({
    queryKey: ["metrics", workspaceId, metricsRange],
    queryFn: () => apiFetch<MetricsResp>(`/admin/api/workspaces/${workspaceId}/metrics?date_range=${metricsRange}`),
    enabled: !!workspaceId,
  });

  const timeseries = metrics.data?.timeseries || [];
  const cpuSeries = timeseries.map((p) => ({ ts: p.ts, cpu: p.cpu_percent ?? null }));
  const memSeries = timeseries.map((p) => ({ ts: p.ts, mem: p.mem_used_pct ?? null }));
  const netSeries = timeseries.map((p) => ({ ts: p.ts, rx: p.net_rx_bytes ?? null, tx: p.net_tx_bytes ?? null }));
  const diskSeries = timeseries.map((p) => ({ ts: p.ts, r: p.disk_read_bytes ?? null, w: p.disk_write_bytes ?? null }));
  const latest = timeseries.length ? timeseries[timeseries.length - 1] : null;
  const cpuLatest = latest?.cpu_percent ?? null;
  const memLatest = latest?.mem_used_pct ?? null;

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-border/70 bg-gradient-to-br from-card/90 via-card/70 to-background p-6 shadow-lg shadow-black/30">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-xs tracking-wider text-primary">观测</div>
            <div className="text-2xl font-semibold text-foreground">观测 / 请求与资源</div>
            <div className="text-sm text-muted-foreground">按请求事件检索 + 容器资源曲线（支持 1h / 24h / 7d）。</div>
            <EntityLinksBar appId={appId} kbId={kbId} className="mt-2" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link to="/">首页</Link>
            </Button>
            {kbId ? (
              <Button asChild variant="outline" size="sm">
                <Link to={`/kbs/${encodeURIComponent(kbId)}`}>打开 KB</Link>
              </Button>
            ) : null}
            {appId ? (
              <Button asChild variant="outline" size="sm">
                <Link to={`/apps/${encodeURIComponent(appId)}`}>打开 App</Link>
              </Button>
            ) : null}

            <div className="ml-2 flex items-center gap-2">
              <div className="text-xs text-muted-foreground">事件时间窗</div>
              <Select
                value={dateRange}
                onChange={(e) => {
                  updateFilter([["date_range", e.target.value]]);
                }}
              >
                <option value="1h">1h</option>
                <option value="24h">24h</option>
                <option value="7d">7d</option>
              </Select>
            </div>
          </div>
        </div>

        {/* 已在标题区使用 EntityLinksBar 提供上下文跳转，避免重复入口 */}

        <div className="mt-4 grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl border border-border/70 bg-background/50 p-4">
            <div className="text-xs text-muted-foreground">CPU（容器）</div>
            <div className="text-2xl font-semibold text-foreground">{cpuLatest != null ? `${Math.round(cpuLatest)}%` : "-"}</div>
            <div className="text-[11px] text-muted-foreground">来自 /metrics 快照</div>
          </div>
          <div className="rounded-xl border border-border/70 bg-background/50 p-4">
            <div className="text-xs text-muted-foreground">内存占用</div>
            <div className="text-2xl font-semibold text-foreground">{memLatest != null ? `${Math.round(memLatest)}%` : "-"}</div>
            <div className="text-[11px] text-muted-foreground">mem_used_pct</div>
          </div>
          <div className="rounded-xl border border-border/70 bg-background/50 p-4">
            <div className="text-xs text-muted-foreground">网络 RX/TX 最新</div>
            <div className="text-sm font-mono text-foreground">
              {latest?.net_rx_bytes != null ? Math.round(latest.net_rx_bytes / 1024) : "-"} /{" "}
              {latest?.net_tx_bytes != null ? Math.round(latest.net_tx_bytes / 1024) : "-"} KB
            </div>
            <div className="text-[11px] text-muted-foreground">累积近似值</div>
          </div>
          <div className="rounded-xl border border-border/70 bg-background/50 p-4">
            <div className="text-xs text-muted-foreground">磁盘 IO 最新</div>
            <div className="text-sm font-mono text-foreground">
              {latest?.disk_read_bytes != null ? Math.round(latest.disk_read_bytes / 1024) : "-"} /{" "}
              {latest?.disk_write_bytes != null ? Math.round(latest.disk_write_bytes / 1024) : "-"} KB
            </div>
            <div className="text-[11px] text-muted-foreground">累积近似值</div>
          </div>
        </div>
      </div>

      <Card
        title="资源指标（容器视角为主）"
        description="容器 cgroup；若配置 NODE_EXPORTER_BASE_URL，则返回宿主机占位；当前窗口采样点绘制。"
        className="border border-border/70 bg-card/80 shadow-lg shadow-black/20"
      >
        {metrics.error ? <ApiErrorBanner error={metrics.error} /> : null}
        <div className="flex flex-wrap items-center gap-3">
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">时间范围</div>
            <Select
              value={metricsRange}
              onChange={(e) => {
                const next = new URLSearchParams(sp);
                next.set("metrics_range", e.target.value);
                setSp(next, { replace: true });
              }}
            >
              <option value="1h">1h</option>
              <option value="24h">24h</option>
              <option value="7d">7d</option>
            </Select>
          </div>
          <div className="flex items-end">
            <Button
              size="sm"
              variant="outline"
              disabled={metricsRange === dateRange}
              onClick={() => {
                const next = new URLSearchParams(sp);
                next.set("metrics_range", dateRange);
                setSp(next, { replace: true });
              }}
            >
              同步时间窗
            </Button>
          </div>
          {metrics.data?.degraded ? <div className="text-xs text-amber-500">仅容器指标可用或采集失败</div> : null}
          {metrics.data?.host && (metrics.data.host as any).error ? (
            <div className="text-xs text-muted-foreground">宿主机：{String((metrics.data.host as any).error)}</div>
          ) : null}
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="rounded-md border bg-muted/20 p-3">
            <div className="text-sm font-semibold">CPU</div>
            <div className="h-36">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={cpuSeries}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="ts" hide />
                  <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} />
                  <Tooltip />
                  <Line type="monotone" dataKey="cpu" stroke="#b5ff66" dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="rounded-md border bg-muted/20 p-3">
            <div className="text-sm font-semibold">内存</div>
            <div className="h-36">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={memSeries}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="ts" hide />
                  <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} />
                  <Tooltip />
                  <Line type="monotone" dataKey="mem" stroke="#8bd1ff" dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="rounded-md border bg-muted/20 p-3">
            <div className="text-sm font-semibold">网络 RX/TX</div>
            <div className="h-36">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={netSeries}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="ts" hide />
                  <YAxis tickFormatter={(v) => `${Math.round((v || 0) / 1024)}KB`} />
                  <Tooltip />
                  <Line type="monotone" dataKey="rx" stroke="#7dd3fc" dot={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="tx" stroke="#f59e0b" dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="rounded-md border bg-muted/20 p-3">
            <div className="text-sm font-semibold">磁盘 IO</div>
            <div className="h-36">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={diskSeries}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="ts" hide />
                  <YAxis tickFormatter={(v) => `${Math.round((v || 0) / 1024)}KB`} />
                  <Tooltip />
                  <Line type="monotone" dataKey="r" stroke="#22c55e" dot={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="w" stroke="#ef4444" dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
        <details className="mt-3 rounded-md border border-border/60 bg-muted/10 p-3">
          <summary className="cursor-pointer select-none text-xs text-muted-foreground">
            Debug（可选）：container.summary（原始 JSON）
          </summary>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[11px] text-muted-foreground font-mono">
            {JSON.stringify(metrics.data?.container?.summary || {}, null, 2)}
          </pre>
        </details>
      </Card>

      {list.error ? <ApiErrorBanner error={list.error} /> : null}

      <Card title="筛选" description="仅存检索调试元数据（hash/len/chunk_ids/scores/timings），不存原文">
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-6">
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">应用ID</div>
            <DebouncedInput
              value={appId}
              onChange={(v) => updateFilter([["app_id", v]])}
              placeholder="例如 app_default"
            />
          </div>
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">知识库ID</div>
            <DebouncedInput
              value={kbId}
              onChange={(v) => updateFilter([["kb_id", v]])}
              placeholder="例如 default"
            />
          </div>
          <div className="space-y-1 lg:col-span-2">
            <div className="text-xs text-muted-foreground">会话ID</div>
            <DebouncedInput
              value={conversationId}
              onChange={(v) => updateFilter([["conversation_id", v]])}
              placeholder="精确匹配"
            />
          </div>
          <div className="space-y-1 lg:col-span-2">
            <div className="text-xs text-muted-foreground">消息ID</div>
            <DebouncedInput
              value={messageId}
              onChange={(v) => updateFilter([["message_id", v]])}
              placeholder="精确匹配"
            />
          </div>
          <div className="space-y-1 lg:col-span-2">
            <div className="text-xs text-muted-foreground">请求ID</div>
            <DebouncedInput
              value={requestId}
              onChange={(v) => updateFilter([["request_id", v]])}
              placeholder="chatcmpl_xxx"
            />
          </div>
          <div className="space-y-1 lg:col-span-2">
            <div className="text-xs text-muted-foreground">错误码</div>
            <DebouncedInput
              value={errorCode}
              onChange={(v) => updateFilter([["error_code", v]])}
              placeholder="例如 prepare_timeout"
            />
          </div>
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">是否有错误</div>
            <Select
              value={hasError}
              onChange={(e) => {
                updateFilter([["has_error", e.target.value]]);
              }}
            >
              <option value="">全部</option>
              <option value="true">是</option>
              <option value="false">否</option>
            </Select>
          </div>
          <div className="flex items-end gap-2">
            <Button
              variant="outline"
              onClick={() => list.refetch()}
            >
              刷新
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setSp(new URLSearchParams(), { replace: true });
              }}
            >
              清空
            </Button>
          </div>
        </div>
        <FilterChips items={chips} className="pt-3" />
      </Card>

      <Card title="列表" description="点击 event_id 查看详情（timings / chunk_ids / sources 等）">
        {list.isLoading ? <Loading /> : null}

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-2">事件ID</th>
                <th className="py-2">时间</th>
                <th className="py-2">应用ID</th>
                <th className="py-2">知识库</th>
                <th className="py-2">请求ID</th>
                <th className="py-2">消息ID</th>
                <th className="py-2">总耗时</th>
                <th className="py-2">错误</th>
              </tr>
            </thead>
            <tbody>
              {(list.data?.items || []).length ? (
                (list.data?.items || []).map((it) => {
                const totalMs = pickNumber(it.timings_ms || {}, "total") ?? pickNumber(it.timings_ms || {}, "total_prepare");
                return (
                  <tr key={it.id} className="border-t align-top">
                      <td className="py-2 font-mono text-xs">
                        <Link
                          className="underline underline-offset-2"
                          to={`/observability/retrieval-events/${it.id}`}
                          state={{
                            from: {
                              // 保留当前筛选：减少「列表 → 详情 → 回列表」时的割裂感
                              search: sp.toString(),
                            },
                          }}
                        >
                          {it.id}
                        </Link>
                      </td>
                    <td className="py-2 font-mono text-xs text-muted-foreground">{it.created_at || "-"}</td>
                    <td className="py-2 font-mono text-xs">
                      {it.app_id ? (
                        <span>
                          <Link
                            className="underline underline-offset-2"
                            to={`/apps/${encodeURIComponent(it.app_id)}`}
                            title="打开 App 详情"
                          >
                            {it.app_id}
                          </Link>
                          <Link
                            className="ml-1 text-muted-foreground underline underline-offset-2"
                            to={`/observability?app_id=${encodeURIComponent(it.app_id)}&date_range=${encodeURIComponent(dateRange)}`}
                            title="在观测中按该 app_id 过滤"
                          >
                            ·筛选
                          </Link>
                        </span>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </td>
                    <td className="py-2 font-mono text-xs">
                      {(it.kb_ids || []).length ? (
                        <div className="flex flex-wrap gap-x-2 gap-y-1">
                          {(it.kb_ids || []).map((kid) => (
                            <span key={kid}>
                              <Link
                                className="underline underline-offset-2"
                                to={it.app_id
                                  ? `/kbs/${encodeURIComponent(kid)}?app_id=${encodeURIComponent(it.app_id)}`
                                  : `/kbs/${encodeURIComponent(kid)}`}
                                title={it.app_id ? "打开 KB（并保留 app 上下文，便于回到应用）" : "打开 KB 详情"}
                              >
                                {kid}
                              </Link>
                              <Link
                                className="ml-1 text-muted-foreground underline underline-offset-2"
                                to={
                                  `/kbs/${encodeURIComponent(kid)}?tab=jobs` +
                                  (it.app_id ? `&app_id=${encodeURIComponent(it.app_id)}` : "")
                                }
                                title="打开该 KB 的任务 Tab"
                              >
                                ·运行
                              </Link>
                              <Link
                                className="ml-1 text-muted-foreground underline underline-offset-2"
                                to={`/observability?kb_id=${encodeURIComponent(kid)}&date_range=${encodeURIComponent(dateRange)}`}
                                title="在观测中按该 kb_id 过滤"
                              >
                                ·筛选
                              </Link>
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </td>
                    <td className="py-2 max-w-[340px]">
                      {it.request_id ? (
                        <TraceLink
                          text={it.request_id}
                          textClassName="font-mono text-xs"
                          toastText="已复制 request_id"
                          to={`/observability/retrieval-events/${it.id}`}
                          toLabel="事件详情"
                          linkState={{ from: { search: sp.toString() } }}
                        />
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </td>
                    <td className="py-2 max-w-[340px]">
                      {it.message_id ? (
                        <TraceLink
                          text={it.message_id}
                          textClassName="font-mono text-xs"
                          toastText="已复制 message_id"
                          to={`/observability?message_id=${encodeURIComponent(it.message_id)}&date_range=${encodeURIComponent(dateRange)}`}
                          toLabel="按 message_id 过滤"
                        />
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </td>
                    <td className="py-2 font-mono text-xs">{totalMs != null ? totalMs : "-"}</td>
                    <td className="py-2 font-mono text-xs">
                      {it.has_error ? <span className="text-red-300">{it.error_code || "error"}</span> : <span className="text-muted-foreground">{it.error_code || "ok"}</span>}
                    </td>
                  </tr>
                );
              })
              ) : (
                <tr className="border-t">
                  <td colSpan={8}>
                    <EmptyState
                      description="暂无观测数据；请确认已产生请求或调整筛选条件。"
                      actions={
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setSp(new URLSearchParams(), { replace: true });
                          }}
                        >
                          清空筛选
                        </Button>
                      }
                      className="py-6"
                    />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <Pagination
          page={list.data?.page || page}
          pageSize={list.data?.page_size || pageSize}
          total={list.data?.total || 0}
          onPageChange={(p) => {
            const next = new URLSearchParams(sp);
            next.set("page", String(p));
            setSp(next, { replace: true });
          }}
        />
      </Card>
    </div>
  );
}
