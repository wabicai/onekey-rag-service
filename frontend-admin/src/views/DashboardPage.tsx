import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { Database, ListChecks, MessageSquareText, ShieldAlert } from "lucide-react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { Card } from "../components/Card";
import { ApiErrorBanner } from "../components/ApiErrorBanner";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card as UiCard, CardContent, CardHeader } from "../components/ui/card";
import { apiFetch } from "../lib/api";
import { useWorkspace } from "../lib/workspace";

type SummaryResp = {
  pages: { total: number; failed: number; last_24h: number; last_crawled_at: string | null };
  chunks: { total: number; with_embedding: number; embedding_coverage: number; embedding_models: Record<string, number> };
  jobs: { by_type: Record<string, Record<string, number>> };
  feedback: { total: number; up: number; down: number; up_ratio: number };
  indexes: { pgvector_hnsw: boolean; pgvector_ivfflat: boolean; fts: boolean };
};
type AlertsResp = { from: string; to: string; items: Array<{ severity: string; code: string; title: string; detail: string; value: unknown }> };
type ObsSummaryResp = {
  from: string;
  to: string;
  pricing_configured: boolean;
  overall: {
    requests: number;
    errors: number;
    hits: number;
    error_ratio: number;
    hit_ratio: number;
    p95_prepare_ms: number | null;
    avg_total_ms: number | null;
    total_tokens: number;
  };
};
// 系统资源快照：已从首页移除（保持 KB-first + 减少无关噪音）
export function DashboardPage() {
  const { workspaceId } = useWorkspace();
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string>("");

  useEffect(() => {
    if (lastUpdated) return;
    setLastUpdated(new Date().toLocaleString("zh-CN"));
  }, [lastUpdated]);

  const summary = useQuery({
    queryKey: ["summary", workspaceId],
    queryFn: () => apiFetch<SummaryResp>(`/admin/api/workspaces/${workspaceId}/summary`),
    enabled: !!workspaceId,
  });

  const health = useQuery({
    queryKey: ["health", workspaceId],
    queryFn: () => apiFetch<{ status: string; dependencies: Record<string, unknown> }>(`/admin/api/workspaces/${workspaceId}/health`),
    enabled: !!workspaceId,
  });

  const settings = useQuery({
    queryKey: ["settings", workspaceId],
    queryFn: () => apiFetch<Record<string, unknown>>(`/admin/api/workspaces/${workspaceId}/settings`),
    enabled: !!workspaceId,
  });

  const alerts = useQuery({
    queryKey: ["alerts", workspaceId],
    queryFn: () => apiFetch<AlertsResp>(`/admin/api/workspaces/${workspaceId}/alerts?date_range=24h`),
    enabled: !!workspaceId,
  });

  const obs24h = useQuery({
    queryKey: ["obs-summary", workspaceId, "24h"],
    queryFn: () => apiFetch<ObsSummaryResp>(`/admin/api/workspaces/${workspaceId}/observability/summary?date_range=24h`),
    enabled: !!workspaceId,
  });

  // 首页已移除系统资源快照卡片：避免把运维指标放在 KB/运行之前。

  if (summary.isLoading) return <div className="text-sm text-muted-foreground">加载中...</div>;
  if (summary.error) return <ApiErrorBanner error={summary.error} />;
  const data = summary.data!;
  const overall = obs24h.data?.overall;
  const topAlerts = (alerts.data?.items || []).slice(0, 3);
  const jobsFailed = sumJobStatus(data.jobs.by_type || {}, "failed");
  const jobsQueued = sumJobStatus(data.jobs.by_type || {}, "queued");
  const jobsRunning = sumJobStatus(data.jobs.by_type || {}, "running");
  const jobsSucceeded = sumJobStatus(data.jobs.by_type || {}, "succeeded");
  const healthStatus = health.data?.status;

  async function refreshAll() {
    if (refreshing) return;
    setRefreshing(true);
    const results = await Promise.allSettled([
      summary.refetch(),
      obs24h.refetch(),
      alerts.refetch(),
      // system.refetch(),
      health.refetch(),
      settings.refetch(),
    ]);
    setLastUpdated(new Date().toLocaleString("zh-CN"));
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed) toast.error(`刷新失败：${failed} 项`);
    setRefreshing(false);
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-border/70 bg-gradient-to-br from-card/90 via-card/70 to-background p-6 shadow-lg shadow-black/30">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-xs tracking-wider text-primary">首页</div>
            <div className="text-2xl font-semibold text-foreground">总览</div>
            <div className="text-sm text-muted-foreground">
              workspace <span className="font-mono">{workspaceId}</span>
              <span className="mx-2 text-border">·</span>
              最近采集 <span className="font-mono">{data.pages.last_crawled_at || "-"}</span>
              <span className="mx-2 text-border">·</span>
              最后更新 <span className="font-mono">{lastUpdated || "-"}</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" disabled={refreshing} onClick={() => void refreshAll()}>
              {refreshing ? "刷新中..." : "刷新"}
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/kbs?create=1">新建知识库</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/observability">观测/排障</Link>
            </Button>
          </div>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          <Link
            to="/observability"
            className="block rounded-xl border border-border/70 bg-background/50 p-4 transition-colors hover:bg-muted/40"
          >
            <div className="text-xs text-muted-foreground">24h 请求</div>
            <div className="text-2xl font-semibold text-foreground">{overall ? formatInt(overall.requests) : "-"}</div>
            <div className="text-[11px] text-muted-foreground">命中率 {overall ? pct(overall.hit_ratio) : "-"} · 错误率 {overall ? pct(overall.error_ratio) : "-"}</div>
          </Link>
          <Link
            to="/kbs"
            className="block rounded-xl border border-border/70 bg-background/50 p-4 transition-colors hover:bg-muted/40"
          >
            <div className="text-xs text-muted-foreground">Embedding 覆盖率</div>
            <div className="text-2xl font-semibold text-foreground">{Math.round((data.chunks.embedding_coverage || 0) * 100)}%</div>
            <div className="text-[11px] text-muted-foreground">
              {formatInt(data.chunks.with_embedding)}/{formatInt(data.chunks.total)} chunks
            </div>
          </Link>
          <Link
            to={jobsFailed > 0 ? "/jobs?status=failed" : "/jobs"}
            className="block rounded-xl border border-border/70 bg-background/50 p-4 transition-colors hover:bg-muted/40"
            title={jobsFailed > 0 ? "查看失败运行" : "打开运行中心"}
          >
            <div className="text-xs text-muted-foreground">运行中 / 失败</div>
            <div className="text-2xl font-semibold text-foreground">
              {formatInt(jobsRunning)} / <span className="text-destructive">{formatInt(jobsFailed)}</span>
            </div>
            <div className="text-[11px] text-muted-foreground">排队 {formatInt(jobsQueued)} · 成功 {formatInt(jobsSucceeded)}</div>
          </Link>
          {/* 系统资源卡片已从首页移除：把“行动入口”留给 KB/运行/观测 */}
        </div>
      </div>

      {healthStatus && healthStatus !== "ok" ? (
        <UiCard className="border-destructive/60 bg-destructive/10 text-destructive-foreground">
          <CardHeader className="flex-row items-start justify-between space-y-0 pb-3">
            <div className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4" />
              <div className="text-sm font-medium">健康状态异常</div>
            </div>
            <Button asChild variant="ghost" size="sm" className="h-8 px-2 text-destructive-foreground hover:bg-destructive/20">
              <Link to="/settings">去处理</Link>
            </Button>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <div className="text-xs text-destructive-foreground/80">
              status=<span className="font-mono">{healthStatus}</span>（建议优先检查数据库/索引/配置）
            </div>
          </CardContent>
        </UiCard>
      ) : null}

      {jobsFailed > 0 ? (
        <UiCard className="border-amber-400/60 bg-amber-500/10 text-amber-50">
          <CardHeader className="flex-row items-start justify-between space-y-0 pb-3">
            <div className="flex items-center gap-2">
              <ListChecks className="h-4 w-4" />
              <div className="text-sm font-medium">存在失败运行</div>
            </div>
            <Button asChild variant="ghost" size="sm" className="h-8 px-2 text-amber-100 hover:bg-amber-400/20">
              <Link to="/jobs?status=failed">查看失败运行</Link>
            </Button>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <div className="text-xs text-amber-100/80">
              failed=<span className="font-mono">{formatInt(jobsFailed)}</span>（建议先在「运行中心」按 failed 过滤，再回到 KB 详情定位 source）
            </div>
          </CardContent>
        </UiCard>
      ) : null}

      {alerts.isLoading ? null : topAlerts.length ? (
        <UiCard className="border-amber-400/60 bg-amber-500/10 text-amber-50">
          <CardHeader className="flex-row items-start justify-between space-y-0 pb-3">
            <div className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4" />
              <div className="text-sm font-medium">告警（最近 24h）</div>
            </div>
            <Button asChild variant="ghost" size="sm" className="h-8 px-2 text-amber-100 hover:bg-amber-400/20">
              <Link to="/observability">去处理</Link>
            </Button>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {topAlerts.map((a) => (
              <div key={a.code} className="rounded-md border border-border/70 bg-background/60 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="font-medium text-foreground">{a.title}</div>
                  <span className="font-mono text-xs text-muted-foreground">{a.severity}</span>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">{a.detail}</div>
              </div>
            ))}
          </CardContent>
        </UiCard>
      ) : null}

      {/* 精简：首页的指标在上方卡片已覆盖；这里不再重复堆叠口径解释。 */}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card title="索引与健康" description="索引结构自检 + 依赖检查">
          {health.isLoading ? <div className="text-sm text-muted-foreground">加载中...</div> : null}
          {health.error ? <ApiErrorBanner error={health.error} /> : null}
          {health.data ? (
            <div className="space-y-2 text-sm">
              <Row
                k="status"
                v={
                  <Badge variant={health.data.status === "ok" ? "default" : "secondary"}>
                    {health.data.status}
                  </Badge>
                }
              />
              <Row k="postgres" v={String(health.data.dependencies?.postgres || "-")} />
              <Row k="pgvector" v={String(health.data.dependencies?.pgvector || "-")} />
              <div className="pt-2 text-xs text-muted-foreground">indexes</div>
              <Row k="HNSW" v={data.indexes.pgvector_hnsw ? "✅" : "❌"} />
              <Row k="IVFFLAT" v={data.indexes.pgvector_ivfflat ? "✅" : "❌"} />
              <Row k="FTS" v={data.indexes.fts ? "✅" : "❌"} />
            </div>
          ) : null}
        </Card>

        <Card
          title="运行概览"
          description="按 status 聚合"
          actions={
            <Button asChild variant="outline" size="sm">
              <Link to="/jobs">运行中心</Link>
            </Button>
          }
        >
          <div className="space-y-2 text-sm">
            <Row k="排队中" v={<span className="font-mono">{formatInt(jobsQueued)}</span>} />
            <Row
              k="运行中"
              v={<span className="font-mono text-blue-400">{formatInt(jobsRunning)}</span>}
            />
            <Row
              k="失败"
              v={<span className="font-mono text-destructive">{formatInt(jobsFailed)}</span>}
            />
            <Row
              k="成功"
              v={<span className="font-mono text-emerald-400">{formatInt(jobsSucceeded)}</span>}
            />
          </div>
          <div className="pt-2 text-xs text-muted-foreground">
            提示：在 <Link className="underline underline-offset-2" to="/kbs">知识库详情</Link> 的「运行」Tab 查看具体运行记录。
          </div>
        </Card>

        <Card title="内容规模" description="采集/索引规模（按 workspace）">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Link to="/kbs" className="block rounded-md border bg-muted/30 p-3 transition-colors hover:bg-muted/40">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-sm">
                  <Database className="h-4 w-4 text-muted-foreground" />
                  <span className="text-muted-foreground">页面</span>
                </div>
                <span className="font-mono text-sm">{formatInt(data.pages.total)}</span>
              </div>
              <div className="mt-2 text-xs text-muted-foreground">
                近 24h 采集 <span className="font-mono">{formatInt(data.pages.last_24h)}</span> · 失败{" "}
                <span className="font-mono">{formatInt(data.pages.failed)}</span>
              </div>
            </Link>

            <Link to="/feedback" className="block rounded-md border bg-muted/30 p-3 transition-colors hover:bg-muted/40" title="打开反馈列表">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-sm">
                  <MessageSquareText className="h-4 w-4 text-muted-foreground" />
                  <span className="text-muted-foreground">反馈</span>
                </div>
                <span className="font-mono text-sm">{formatInt(data.feedback.total)}</span>
              </div>
              <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  👍 <span className="font-mono">{formatInt(data.feedback.up)}</span> · 👎{" "}
                  <span className="font-mono">{formatInt(data.feedback.down)}</span>
                </span>
                <span className="font-mono">{pct(data.feedback.up_ratio)}</span>
              </div>
            </Link>
          </div>
        </Card>
      </div>

      <UiCard>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
          <div>
            <div className="text-sm font-medium">关键配置（脱敏）</div>
            <div className="mt-1 text-xs text-muted-foreground">只展示常用字段；完整配置见“设置”页</div>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link to="/settings">打开设置</Link>
          </Button>
        </CardHeader>
        <CardContent>
          {settings.isLoading ? <div className="text-sm text-muted-foreground">加载中...</div> : null}
          {settings.error ? <ApiErrorBanner error={settings.error} /> : null}
          {settings.data ? (
            <div className="grid grid-cols-1 gap-3 text-sm md:grid-cols-2 lg:grid-cols-3">
              <KeyVal k="retrieval.mode" v={String((settings.data as any)?.retrieval?.mode ?? "-")} />
              <KeyVal k="retrieval.rag_top_k" v={String((settings.data as any)?.retrieval?.rag_top_k ?? "-")} />
              <KeyVal k="models.chat.model" v={String((settings.data as any)?.models?.chat?.model ?? "-")} />
              <KeyVal k="models.embeddings.provider" v={String((settings.data as any)?.models?.embeddings?.provider ?? "-")} />
              <KeyVal k="models.rerank.provider" v={String((settings.data as any)?.models?.rerank?.provider ?? "-")} />
              <KeyVal k="jobs.backend" v={String((settings.data as any)?.jobs?.backend ?? "-")} />
            </div>
          ) : null}
        </CardContent>
      </UiCard>
    </div>
  );
}

function formatInt(v: number): string {
  try {
    return new Intl.NumberFormat("zh-CN").format(v);
  } catch {
    return String(v);
  }
}

function pct(v: number): string {
  if (!Number.isFinite(v)) return "-";
  return `${Math.round(v * 100)}%`;
}


function Row(props: { k: string; v: ReactNode }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <div className="text-muted-foreground">{props.k}</div>
      <div className="text-foreground">{props.v}</div>
    </div>
  );
}

function KeyVal(props: { k: string; v: ReactNode }) {
  return (
    <div className="rounded-md border bg-muted/30 p-3">
      <div className="text-xs text-muted-foreground">{props.k}</div>
      <div className="mt-1 font-mono text-xs text-foreground">{props.v}</div>
    </div>
  );
}

// MetricCard 已移除：首页避免重复堆叠指标口径。

function sumJobStatus(byType: Record<string, Record<string, number>>, status: string): number {
  let total = 0;
  for (const perType of Object.values(byType || {})) {
    total += Number(perType?.[status] || 0);
  }
  return total;
}
