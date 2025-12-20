import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";

import { Card } from "../components/Card";
import { ApiErrorBanner } from "../components/ApiErrorBanner";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Select } from "../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { EmptyState } from "../components/EmptyState";
import { CopyableText } from "../components/CopyableText";
import { apiFetch } from "../lib/api";
import { useWorkspace } from "../lib/workspace";

type SummaryResp = {
  from: string;
  to: string;
  pricing_configured: boolean;
  overall: {
    requests: number;
    errors: number;
    hits: number;
    error_ratio: number;
    hit_ratio: number;
    avg_prepare_ms: number | null;
    p50_prepare_ms: number | null;
    p95_prepare_ms: number | null;
    avg_embed_ms: number | null;
    avg_retrieve_ms: number | null;
    avg_rerank_ms: number | null;
    avg_context_ms: number | null;
    avg_chat_ms: number | null;
    avg_total_ms: number | null;
    avg_retrieved: number | null;
    avg_topn: number | null;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  by_app: Array<{
    app_id: string;
    requests: number;
    errors: number;
    hits: number;
    error_ratio: number;
    hit_ratio: number;
    p95_prepare_ms: number | null;
    avg_prepare_ms: number | null;
    avg_retrieve_ms: number | null;
    avg_retrieved: number | null;
    total_tokens: number;
  }>;
  by_app_kb: Array<{
    app_id: string;
    kb_id: string;
    requests: number;
    errors: number;
    hits: number;
    error_ratio: number;
    hit_ratio: number;
    avg_prepare_ms: number | null;
    avg_retrieve_ms: number | null;
    avg_retrieved: number | null;
    total_tokens: number;
  }>;
  errors: Array<{ code: string; cnt: number }>;
  topk: Array<{ retrieved: number; cnt: number }>;
  tokens_by_model: Array<{
    model: string;
    requests: number;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cost_usd_estimate: number | null;
  }>;
  rerank_effect?: { sample_events: number; sample_pairs: number; avg_delta: number | null };
};

function pct(v: number): string {
  if (!Number.isFinite(v)) return "-";
  return `${Math.round(v * 100)}%`;
}

function ms(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "-";
  return `${Math.round(v)}ms`;
}


export function QualityPage() {
  const { workspaceId } = useWorkspace();
  const [range, setRange] = useState<string>("24h");

  const q = useQuery({
    queryKey: ["obs-summary", workspaceId, range],
    queryFn: () => apiFetch<SummaryResp>(`/admin/api/workspaces/${workspaceId}/observability/summary?date_range=${encodeURIComponent(range)}`),
    enabled: !!workspaceId,
  });

  const overall = q.data?.overall;
  const noRequests = !!overall && (overall.requests || 0) <= 0;
  const hasPartialNullMetrics =
    !!overall &&
    (overall.requests || 0) > 0 &&
    [
      overall.p95_prepare_ms,
      overall.avg_prepare_ms,
      overall.avg_retrieve_ms,
      overall.avg_rerank_ms,
      overall.avg_chat_ms,
      overall.avg_total_ms,
      overall.avg_retrieved,
      overall.avg_topn,
    ].some((v) => v == null);
  const overallBadge = useMemo(() => {
    if (!overall) return { text: "-", variant: "outline" as const };
    if ((overall.error_ratio || 0) >= 0.1) return { text: "高错误率", variant: "destructive" as const };
    if ((overall.error_ratio || 0) >= 0.02) return { text: "需关注", variant: "secondary" as const };
    return { text: "健康", variant: "default" as const };
  }, [overall]);

  const pricingExample = useMemo(() => {
    const model =
      (q.data?.tokens_by_model || []).map((r) => (r.model || "").trim()).find(Boolean) || "gpt-4o-mini";
    return JSON.stringify({
      [model]: { prompt_usd_per_1k: 0.00015, completion_usd_per_1k: 0.0006 },
    });
  }, [q.data?.tokens_by_model]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-lg font-semibold">质量与可观测</div>
        <div className="flex items-center gap-2">
          <div className="text-xs text-muted-foreground">时间范围</div>
          <Select value={range} onChange={(e) => setRange(e.target.value)}>
            <option value="24h">24h</option>
            <option value="7d">7d</option>
            <option value="30d">30d</option>
          </Select>
        </div>
      </div>

      {q.isLoading ? <div className="text-sm text-muted-foreground">加载中...</div> : null}
      {q.error ? <ApiErrorBanner error={q.error} /> : null}

      {q.data ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card
            title="总体"
            description={`from=${q.data.from} · to=${q.data.to}`}
            actions={<Badge variant={overallBadge.variant}>{overallBadge.text}</Badge>}
          >
            {overall ? (
              <div className="space-y-2 text-sm">
                {noRequests ? (
                  <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
                    时间范围内没有请求，延迟/命中率/TopK 等派生指标将显示为 “-”。建议扩大时间范围，或先发起一次对话请求产生观测数据。
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button type="button" size="sm" variant="outline" onClick={() => setRange("7d")}>
                        查看 7d
                      </Button>
                      <Button asChild type="button" size="sm" variant="outline">
                        <Link to="/observability">去观测页</Link>
                      </Button>
                    </div>
                  </div>
                ) : hasPartialNullMetrics ? (
                  <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
                    部分指标为 “-” 通常表示观测字段未上报（历史数据/版本差异）或样本不足；可扩大时间范围，或检查{" "}
                    <Link className="underline underline-offset-2" to="/settings">
                      设置
                    </Link>{" "}
                    中的 RETRIEVAL_EVENTS_ENABLED 等开关。
                  </div>
                ) : null}
                <Row k="requests" v={overall.requests} />
                <Row k="errors" v={`${overall.errors} (${pct(overall.error_ratio)})`} />
                <Row k="hits" v={`${overall.hits} (${pct(overall.hit_ratio)})`} />
                <Row k="p95_prepare" v={ms(overall.p95_prepare_ms)} />
                <Row k="avg_prepare" v={ms(overall.avg_prepare_ms)} />
                <Row k="avg_retrieve" v={ms(overall.avg_retrieve_ms)} />
                <Row k="avg_rerank" v={ms(overall.avg_rerank_ms)} />
                <Row k="avg_chat" v={ms(overall.avg_chat_ms)} />
                <Row k="avg_total" v={ms(overall.avg_total_ms)} />
                <Row k="avg_retrieved" v={overall.avg_retrieved != null ? overall.avg_retrieved.toFixed(1) : "-"} />
                <Row k="avg_topn" v={overall.avg_topn != null ? overall.avg_topn.toFixed(1) : "-"} />
                <Row k="total_tokens" v={overall.total_tokens} />
              </div>
            ) : null}
          </Card>

          <Card title="Token/成本（按上游模型）" description={q.data.pricing_configured ? "已配置 MODEL_PRICING_JSON" : "未配置 MODEL_PRICING_JSON，仅展示 tokens"}>
            {!q.data.pricing_configured ? (
              <div className="pb-3 text-xs text-muted-foreground">
                成本列为 “-” 表示未配置计价；可在 <Link className="underline underline-offset-2" to="/settings">设置</Link> 中配置 MODEL_PRICING_JSON。
                <div className="mt-2 space-y-1">
                  <div>示例（复制后写入环境变量并重启服务）：</div>
                  <CopyableText
                    text={pricingExample}
                    textClassName="font-mono text-xs"
                    toastText="已复制示例 MODEL_PRICING_JSON"
                  />
                </div>
              </div>
            ) : null}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>model</TableHead>
                  <TableHead className="text-right">requests</TableHead>
                  <TableHead className="text-right">tokens</TableHead>
                  <TableHead className="text-right">cost(USD)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(q.data.tokens_by_model || []).length ? (
                  (q.data.tokens_by_model || []).map((r) => (
                    <TableRow key={r.model || "(none)"}>
                      <TableCell className="font-mono text-xs">{r.model || "(none)"}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{r.requests}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{r.total_tokens}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{r.cost_usd_estimate == null ? "-" : r.cost_usd_estimate.toFixed(4)}</TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={4}>
                      <EmptyState description="暂无数据；请确认时间范围内已有请求。" className="py-6" />
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </Card>

          <Card title="Rerank 效果（抽样）" description="top_scores 与 top_scores_pre_rerank 的差值均值（越大越好，仅用于趋势）">
            <div className="space-y-2 text-sm">
              {(q.data.rerank_effect?.sample_events ?? 0) <= 0 ? (
                <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
                  avg_delta 为 “-” 通常表示抽样不足或未启用 rerank；可扩大时间范围，或检查 <Link className="underline underline-offset-2" to="/settings">设置</Link> 中的 RERANK 配置。
                </div>
              ) : null}
              <Row k="sample_events" v={q.data.rerank_effect?.sample_events ?? 0} />
              <Row k="sample_pairs" v={q.data.rerank_effect?.sample_pairs ?? 0} />
              <Row k="avg_delta" v={q.data.rerank_effect?.avg_delta == null ? "-" : q.data.rerank_effect.avg_delta.toFixed(4)} />
            </div>
          </Card>

          <Card title="按 App" description="请求量/错误率/命中率/p95/索引召回规模">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>app_id</TableHead>
                  <TableHead className="text-right">req</TableHead>
                  <TableHead className="text-right">err</TableHead>
                  <TableHead className="text-right">hit</TableHead>
                  <TableHead className="text-right">p95</TableHead>
                  <TableHead className="text-right">avg_retrieved</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(q.data.by_app || []).length ? (
                  (q.data.by_app || []).map((r) => (
                    <TableRow key={r.app_id || "(none)"}>
                      <TableCell className="font-mono text-xs">{r.app_id || "(none)"}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{r.requests}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{pct(r.error_ratio)}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{pct(r.hit_ratio)}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{ms(r.p95_prepare_ms)}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{r.avg_retrieved != null ? r.avg_retrieved.toFixed(1) : "-"}</TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={6}>
                      <EmptyState description="暂无数据；请确认时间范围内已有请求。" className="py-6" />
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </Card>

          <Card title="按 App + KB" description="多 KB 场景下更贴近实际召回范围">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>app_id</TableHead>
                  <TableHead>kb_id</TableHead>
                  <TableHead className="text-right">req</TableHead>
                  <TableHead className="text-right">err</TableHead>
                  <TableHead className="text-right">hit</TableHead>
                  <TableHead className="text-right">avg_prepare</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(q.data.by_app_kb || []).length ? (
                  (q.data.by_app_kb || []).slice(0, 50).map((r) => (
                    <TableRow key={`${r.app_id}_${r.kb_id}`}>
                      <TableCell className="font-mono text-xs">{r.app_id || "(none)"}</TableCell>
                      <TableCell className="font-mono text-xs">{r.kb_id || "(none)"}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{r.requests}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{pct(r.error_ratio)}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{pct(r.hit_ratio)}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{ms(r.avg_prepare_ms)}</TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={6}>
                      <EmptyState description="暂无数据；请确认时间范围内已有请求。" className="py-6" />
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
            <div className="pt-2 text-xs text-muted-foreground">仅展示前 50 行（避免页面过长）。</div>
          </Card>

          <Card title="错误码 Top" description="error 字段前缀聚合（ok/prepare_timeout/chat_error/...）">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>code</TableHead>
                  <TableHead className="text-right">count</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(q.data.errors || []).length ? (
                  (q.data.errors || []).map((r) => (
                    <TableRow key={r.code}>
                      <TableCell className="font-mono text-xs">
                        <Link
                          className="underline underline-offset-2"
                          to={
                            r.code === "ok"
                              ? `/observability?has_error=false&date_range=${encodeURIComponent(range)}`
                              : `/observability?has_error=true&error_code=${encodeURIComponent(r.code)}&date_range=${encodeURIComponent(range)}`
                          }
                        >
                          {r.code}
                        </Link>
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">{r.cnt}</TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={2}>
                      <EmptyState description="暂无错误数据（可能表示无请求或错误率为 0）。" className="py-6" />
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </Card>

          <Card title="topK（retrieved）分布" description="每次检索召回候选数的分布（来自 retrieval.retrieved）">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-right">retrieved</TableHead>
                  <TableHead className="text-right">count</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(q.data.topk || []).length ? (
                  (q.data.topk || []).map((r) => (
                    <TableRow key={r.retrieved}>
                      <TableCell className="text-right font-mono text-xs">{r.retrieved}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{r.cnt}</TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={2}>
                      <EmptyState description="暂无数据；请确认时间范围内已有请求。" className="py-6" />
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </Card>
        </div>
      ) : null}
    </div>
  );
}

function Row(props: { k: string; v: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="text-muted-foreground">{props.k}</div>
      <div className="text-right">{props.v}</div>
    </div>
  );
}
