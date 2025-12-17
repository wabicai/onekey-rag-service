import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";

import { Button } from "../components/ui/button";
import { Card } from "../components/Card";
import { JsonView } from "../components/JsonView";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../components/ui/alert-dialog";
import { apiFetch } from "../lib/api";
import { useMe } from "../lib/useMe";

type PageDetail = {
  id: number;
  kb_id: string;
  source_id: string;
  url: string;
  title: string;
  http_status: number;
  last_crawled_at: string | null;
  content_markdown: string;
  chunk_stats: { total: number; with_embedding: number; embedding_coverage: number; embedding_models: Record<string, number> };
  meta: Record<string, unknown>;
};

export function PageDetailPage() {
  const me = useMe();
  const workspaceId = me.data?.workspace_id || "default";
  const params = useParams();
  const pageId = Number(params.pageId || 0);
  const navigate = useNavigate();
  const qc = useQueryClient();

  const q = useQuery({
    queryKey: ["page", workspaceId, pageId],
    queryFn: () => apiFetch<PageDetail>(`/admin/api/workspaces/${workspaceId}/pages/${pageId}`),
    enabled: !!workspaceId && Number.isFinite(pageId) && pageId > 0,
  });

  const recrawl = useMutation({
    mutationFn: async () => {
      return apiFetch<{ job_id: string }>(`/admin/api/workspaces/${workspaceId}/pages/${pageId}/recrawl`, { method: "POST" });
    },
    onSuccess: async (data) => {
      await qc.invalidateQueries({ queryKey: ["pages", workspaceId] });
      await qc.invalidateQueries({ queryKey: ["page", workspaceId, pageId] });
      toast.success("已触发 recrawl，正在跳转任务详情");
      navigate(`/jobs/${data.job_id}`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "触发失败"),
  });

  const del = useMutation({
    mutationFn: async () => {
      return apiFetch<{ ok: boolean }>(`/admin/api/workspaces/${workspaceId}/pages/${pageId}`, { method: "DELETE" });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["pages", workspaceId] });
      toast.success("已删除 Page");
      navigate("/pages", { replace: true });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "删除失败"),
  });

  const actionError = useMemo(() => {
    const err = recrawl.error || del.error;
    if (!err) return "";
    return err instanceof Error ? err.message : String(err);
  }, [recrawl.error, del.error]);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-lg font-semibold">Page 详情</div>
          <div className="mt-1 text-xs text-muted-foreground">
            <Link className="underline underline-offset-2" to="/pages">
              返回 Pages 列表
            </Link>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" disabled={!q.data || recrawl.isPending} onClick={() => recrawl.mutate()}>
            {recrawl.isPending ? "触发中..." : "recrawl"}
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" disabled={!q.data || del.isPending}>
                删除
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>确认删除 Page？</AlertDialogTitle>
                <AlertDialogDescription>
                  将删除 page_id=<span className="font-mono">{pageId}</span>，并级联删除其 chunks（如存在）。
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>取消</AlertDialogCancel>
                <AlertDialogAction onClick={() => del.mutate()}>继续删除</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {actionError ? <div className="text-sm text-destructive">{actionError}</div> : null}

      {q.isLoading ? <div className="text-sm text-muted-foreground">加载中...</div> : null}
      {q.error ? <div className="text-sm text-destructive">{String(q.error)}</div> : null}

      {q.data ? (
        <div className="space-y-4">
          <Card title="基本信息">
            <div className="grid grid-cols-1 gap-3 text-sm lg:grid-cols-3">
              <div>
                <div className="text-xs text-muted-foreground">ID</div>
                <div className="font-mono text-xs">{q.data.id}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">KB</div>
                <div className="font-mono text-xs">{q.data.kb_id}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Source</div>
                <div className="font-mono text-xs">{q.data.source_id || "-"}</div>
              </div>
              <div className="lg:col-span-3">
                <div className="text-xs text-muted-foreground">URL</div>
                <a className="break-all underline underline-offset-2" href={q.data.url} target="_blank" rel="noreferrer">
                  {q.data.url}
                </a>
              </div>
              <div className="lg:col-span-2">
                <div className="text-xs text-muted-foreground">标题</div>
                <div>{q.data.title || <span className="text-muted-foreground">-</span>}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">HTTP</div>
                <div className={q.data.http_status >= 400 ? "text-destructive" : ""}>{q.data.http_status || "-"}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">last_crawled_at</div>
                <div className="font-mono text-xs">{q.data.last_crawled_at || "-"}</div>
              </div>
            </div>
          </Card>

          <Card title="Chunks 统计" description="用于排障：chunk 数量、embedding 覆盖率与模型分布">
            <div className="grid grid-cols-1 gap-3 text-sm lg:grid-cols-3">
              <div>
                <div className="text-xs text-muted-foreground">total</div>
                <div className="font-mono text-xs">{q.data.chunk_stats?.total ?? 0}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">with_embedding</div>
                <div className="font-mono text-xs">{q.data.chunk_stats?.with_embedding ?? 0}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">embedding_coverage</div>
                <div className="font-mono text-xs">{Math.round((q.data.chunk_stats?.embedding_coverage ?? 0) * 100)}%</div>
              </div>
            </div>
            <div className="pt-2">
              <div className="text-xs text-muted-foreground">embedding_models</div>
              <JsonView value={q.data.chunk_stats?.embedding_models || {}} />
            </div>
          </Card>

          <Card title="Markdown（原始内容）" description="当前为纯文本预览；如需富文本预览可再引入 Markdown 渲染组件">
            <pre className="max-h-[520px] overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted p-3 text-xs leading-relaxed">
              {q.data.content_markdown || ""}
            </pre>
          </Card>

          <Card title="Meta">
            <JsonView value={q.data.meta || {}} />
          </Card>
        </div>
      ) : null}
    </div>
  );
}
