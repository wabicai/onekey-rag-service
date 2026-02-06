import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";

import { ConfirmDangerDialog } from "../components/ConfirmDangerDialog";
import { Button } from "../components/ui/button";
import { Card } from "../components/Card";
import { JsonView } from "../components/JsonView";
import { ApiErrorBanner } from "../components/ApiErrorBanner";
import { EntityLinksBar } from "../components/EntityLinksBar";
import { apiFetch } from "../lib/api";
import { useWorkspace } from "../lib/workspace";

type JobDetail = {
  id: string;
  type: string;
  status: string;
  workspace_id: string;
  kb_id: string;
  app_id: string;
  source_id: string;
  payload: Record<string, unknown>;
  progress: Record<string, unknown>;
  logs?: Array<Record<string, unknown>>;
  subtasks?: Array<{ id: string; filename?: string; size_bytes?: number; status?: string; error?: string }>;
  error: string;
  started_at: string | null;
  finished_at: string | null;
};

function shouldPoll(status?: string) {
  return status === "queued" || status === "running";
}

export function JobDetailPage() {
  const { workspaceId } = useWorkspace();
  const params = useParams();
  const jobId = params.jobId || "";
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();

  const from = (location.state as any)?.from as { kb_id?: string; source_id?: string } | undefined;

  const q = useQuery({
    queryKey: ["job", workspaceId, jobId],
    queryFn: () => apiFetch<JobDetail>(`/admin/api/workspaces/${workspaceId}/jobs/${jobId}`),
    enabled: !!workspaceId && !!jobId,
    refetchInterval: (query) => (shouldPoll(query.state.data?.status) ? 1000 : false),
  });

  const requeue = useMutation({
    mutationFn: async () => {
      return apiFetch<{ ok: boolean }>(`/admin/api/workspaces/${workspaceId}/jobs/${jobId}/requeue`, { method: "POST" });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["job", workspaceId, jobId] });
      // JobsPage 使用 all-jobs 作为 queryKey（含筛选）；这里用前缀失效，确保列表能立刻刷新。
      await qc.invalidateQueries({ queryKey: ["all-jobs", workspaceId] });
      toast.success("已重新入队");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "重新入队失败"),
  });

  const cancel = useMutation({
    mutationFn: async () => {
      return apiFetch<{ ok: boolean }>(`/admin/api/workspaces/${workspaceId}/jobs/${jobId}/cancel`, { method: "POST" });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["job", workspaceId, jobId] });
      await qc.invalidateQueries({ queryKey: ["all-jobs", workspaceId] });
      toast.success("已取消运行");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "取消失败"),
  });

  const actionError = requeue.error || cancel.error;

  // 智能返回逻辑：优先遵循来源页面 state.from（用于保留 kb/source 上下文），其次返回 KB 详情，否则返回上一页
  const handleGoBack = () => {
    if (from?.kb_id) {
      const qs = new URLSearchParams();
      qs.set("tab", "jobs");
      if (from.source_id) qs.set("source_id", from.source_id);
      navigate(`/kbs/${encodeURIComponent(from.kb_id)}?${qs.toString()}`);
      return;
    }

    if (q.data?.kb_id) {
      navigate(`/kbs/${encodeURIComponent(q.data.kb_id)}?tab=jobs`);
      return;
    }

    if (window.history.length > 1) {
      navigate(-1);
      return;
    }

    navigate("/kbs");
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="sm" onClick={handleGoBack} className="gap-1 px-2">
              <ArrowLeft className="h-4 w-4" />
              返回
            </Button>
            <span className="text-lg font-semibold">运行详情</span>
            <Button asChild variant="outline" size="sm" title="回到知识库详情页的『运行』Tab，并自动展开这次运行（KB-first）">
              <Link
                to={(() => {
                  const kb_id = from?.kb_id || q.data?.kb_id;
                  const source_id = from?.source_id || q.data?.source_id;
                  if (!kb_id) return "/kbs";
                  const qs = new URLSearchParams();
                  qs.set("tab", "jobs");
                  qs.set("job_id", jobId);
                  if (source_id) qs.set("source_id", source_id);
                  return `/kbs/${encodeURIComponent(kb_id)}?${qs.toString()}`;
                })()}
              >
                回到知识库（展开）
              </Link>
            </Button>
          </div>
          <div className="mt-1 text-xs text-muted-foreground">提示：详情页是兜底；日常从「知识库详情页 → 运行」或「运行中心」看更顺。</div>
          <EntityLinksBar appId={q.data?.app_id} kbId={q.data?.kb_id} sourceId={q.data?.source_id} className="mt-2" />

          {from?.kb_id ? (
            <div className="mt-2 text-xs text-muted-foreground">
              来源：
              <Link
                className="underline underline-offset-2"
                to={`/kbs/${encodeURIComponent(from.kb_id)}?tab=jobs${from.source_id ? `&source_id=${encodeURIComponent(from.source_id)}` : ""}`}
                title="回到触发跳转的 KB / 任务视图（尽量保留 source_id 筛选）"
              >
                返回来源视图
              </Link>
            </div>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <ConfirmDangerDialog
            trigger={
              <Button variant="outline" disabled={!q.data || requeue.isPending}>
                {requeue.isPending ? "重新入队中..." : "重新入队"}
              </Button>
            }
            title="确认重新入队？"
            description={
              <>
                将把 job_id=<span className="font-mono">{jobId}</span> 的状态重置为 queued，并清空 progress/error。建议仅用于排障重试。
              </>
            }
            confirmLabel="继续重新入队"
            confirmDisabled={!q.data || requeue.isPending}
            onConfirm={() => requeue.mutateAsync()}
          />
          <ConfirmDangerDialog
            trigger={
              <Button variant="outline" disabled={!q.data || q.data.status !== "queued" || cancel.isPending}>
                {cancel.isPending ? "取消中..." : "取消（仅排队）"}
              </Button>
            }
            title="确认取消运行？"
            description={
              <>
                将取消 job_id=<span className="font-mono">{jobId}</span>（仅支持 queued/排队中）。此操作不可恢复。
              </>
            }
            confirmLabel="继续取消"
            confirmVariant="destructive"
            confirmDisabled={!q.data || q.data.status !== "queued" || cancel.isPending}
            onConfirm={() => cancel.mutateAsync()}
          />
        </div>
      </div>

      {actionError ? <ApiErrorBanner error={actionError} /> : null}

      {q.isLoading ? <div className="text-sm text-muted-foreground">加载中...</div> : null}
      {q.error ? <ApiErrorBanner error={q.error} /> : null}

      {q.data ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card title="基本信息">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <div className="text-xs text-muted-foreground">ID</div>
                <div className="font-mono text-xs">{q.data.id}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">状态</div>
                <div className="font-mono">{q.data.status}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">类型</div>
                <div className="font-mono">{q.data.type}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">KB</div>
                {q.data.kb_id ? (
                  <Link
                    className="font-mono text-xs underline underline-offset-2"
                    to={`/kbs/${encodeURIComponent(q.data.kb_id)}?tab=jobs${q.data.source_id ? `&source_id=${encodeURIComponent(q.data.source_id)}` : ""}`}
                    title="回到该 KB 的任务 Tab（并尽量保留 source_id 筛选）"
                  >
                    {q.data.kb_id}
                  </Link>
                ) : (
                  <div className="font-mono text-xs">-</div>
                )}
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Source</div>
                <div className="flex items-center gap-2">
                  <div className="font-mono text-xs">{q.data.source_id || "-"}</div>
                  {q.data.kb_id ? (
                    <Link className="text-xs underline underline-offset-2" to={`/kbs/${encodeURIComponent(q.data.kb_id)}?tab=sources${q.data.source_id ? `&source_id=${encodeURIComponent(q.data.source_id)}` : ""}`}>
                      查看数据源
                    </Link>
                  ) : null}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">App</div>
                {q.data.app_id ? (
                  <Link className="font-mono text-xs underline underline-offset-2" to={`/apps/${encodeURIComponent(q.data.app_id)}`}>
                    {q.data.app_id}
                  </Link>
                ) : (
                  <div className="font-mono text-xs">-</div>
                )}
              </div>
              <div>
                <div className="text-xs text-muted-foreground">开始</div>
                <div className="font-mono text-xs">{q.data.started_at || "-"}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">结束</div>
                <div className="font-mono text-xs">{q.data.finished_at || "-"}</div>
              </div>
            </div>
          </Card>

          <Card title="错误信息" description="error 字段（如失败会有内容）">
            {q.data.error ? (
              <pre className="whitespace-pre-wrap break-words rounded-md border bg-muted p-3 text-xs text-destructive">
                {q.data.error}
              </pre>
            ) : (
              <div className="text-sm text-muted-foreground">无</div>
            )}
          </Card>

          <Card title="Payload" className="lg:col-span-2">
            <JsonView value={q.data.payload || {}} />
          </Card>

          <Card title="Progress" className="lg:col-span-2">
            <JsonView value={q.data.progress || {}} />
          </Card>

          {q.data.subtasks?.length ? (
            <Card title="子任务 / 文件" description="file_process 返回的文件列表">
              <div className="space-y-2 text-xs">
                {q.data.subtasks.map((s) => (
                  <div key={s.id} className="flex items-center justify-between gap-2 rounded-md border bg-muted/40 p-2 font-mono">
                    <span className="truncate">{s.filename || s.id}</span>
                    <span className={s.status === "failed" ? "text-destructive" : "text-muted-foreground"}>{s.status}</span>
                    <span className="text-muted-foreground">{s.error || ""}</span>
                  </div>
                ))}
              </div>
            </Card>
          ) : null}

          {q.data.logs?.length ? (
            <Card title="日志" description="运行进度日志摘要">
              <div className="space-y-1 text-xs font-mono text-muted-foreground">
                {q.data.logs.map((l, idx) => (
                  <div key={idx} className="truncate">
                    {JSON.stringify(l)}
                  </div>
                ))}
              </div>
            </Card>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
