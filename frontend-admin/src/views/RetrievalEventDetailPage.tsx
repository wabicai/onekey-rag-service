import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useParams } from "react-router-dom";

import { Card } from "../components/Card";
import { JsonView } from "../components/JsonView";
import { ApiErrorBanner } from "../components/ApiErrorBanner";
import { TraceLink } from "../components/TraceLink";
import { EntityLinksBar } from "../components/EntityLinksBar";
import { Button } from "../components/ui/button";
import { apiFetch } from "../lib/api";
import { useWorkspace } from "../lib/workspace";

type RetrievalEventDetail = {
  id: number;
  app_id: string;
  kb_ids: string[];
  request_id: string;
  conversation_id: string;
  message_id: string;
  question_sha256: string;
  question_len: number;
  retrieval_query_sha256: string;
  retrieval_query_len: number;
  timings_ms: Record<string, unknown>;
  retrieval: Record<string, unknown>;
  sources: Record<string, unknown>;
  token_usage: Record<string, unknown>;
  error: string;
  created_at: string | null;
};

export function RetrievalEventDetailPage() {
  const { workspaceId } = useWorkspace();
  const params = useParams();
  const eventId = Number(params.eventId || 0);
  const location = useLocation();

  const rawFromSearch = (location.state as any)?.from?.search as string | undefined;
  const fromSearch = new URLSearchParams(rawFromSearch || "").toString();
  const backToList = fromSearch ? `/observability?${fromSearch}` : "/observability";

  const q = useQuery({
    queryKey: ["retrieval-event", workspaceId, eventId],
    queryFn: () => apiFetch<RetrievalEventDetail>(`/admin/api/workspaces/${workspaceId}/retrieval-events/${eventId}`),
    enabled: !!workspaceId && Number.isFinite(eventId) && eventId > 0,
  });

  const data = q.data;
  const firstKbId = data?.kb_ids?.[0] || "";

  return (
    <div className="space-y-4">
      <div>
        <div className="text-lg font-semibold">检索事件详情</div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <Link className="underline underline-offset-2" to={backToList}>
            返回列表{fromSearch ? "（保留筛选）" : ""}
          </Link>
          {data?.request_id ? (
            <Link className="underline underline-offset-2" to={`/observability?request_id=${encodeURIComponent(data.request_id)}`}>
              回到列表（带 request_id）
            </Link>
          ) : null}
        </div>

        {/* 快捷动作：把“观测 → 定位 KB → 看运行/数据源 → 回修复”串起来 */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {firstKbId ? (
            <Button asChild size="sm" variant="outline">
              <Link to={`/kbs/${encodeURIComponent(firstKbId)}?tab=jobs${data?.app_id ? `&app_id=${encodeURIComponent(data.app_id)}` : ""}`}>
                打开该 KB（运行）
              </Link>
            </Button>
          ) : null}
          {firstKbId ? (
            <Button asChild size="sm" variant="outline">
              <Link to={`/kbs/${encodeURIComponent(firstKbId)}?tab=sources${data?.app_id ? `&app_id=${encodeURIComponent(data.app_id)}` : ""}`}>
                打开该 KB（数据源）
              </Link>
            </Button>
          ) : null}
          {firstKbId ? (
            <Button asChild size="sm" variant="outline">
              <Link
                to={`/observability?kb_id=${encodeURIComponent(firstKbId)}${data?.app_id ? `&app_id=${encodeURIComponent(data.app_id)}` : ""}`}
              >
                回到观测（该 KB）
              </Link>
            </Button>
          ) : null}
        </div>

        <EntityLinksBar appId={data?.app_id} kbId={firstKbId} className="mt-2" />
      </div>

      {q.isLoading ? <div className="text-sm text-muted-foreground">加载中...</div> : null}
      {q.error ? <ApiErrorBanner error={q.error} /> : null}

      {q.data ? (
        <div className="space-y-4">
          <Card title="基本信息">
            <div className="grid grid-cols-1 gap-3 text-sm lg:grid-cols-3">
              <div>
                <div className="text-xs text-muted-foreground">event_id</div>
                <div className="font-mono text-xs">{q.data.id}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">created_at</div>
                <div className="font-mono text-xs">{q.data.created_at || "-"}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">app_id</div>
                {q.data.app_id ? (
                  <Link className="font-mono text-xs underline underline-offset-2" to={`/apps/${encodeURIComponent(q.data.app_id)}`}>
                    {q.data.app_id}
                  </Link>
                ) : (
                  <div className="font-mono text-xs">-</div>
                )}
              </div>
              <div>
                <div className="text-xs text-muted-foreground">kb_ids</div>
                {(q.data.kb_ids || []).length ? (
                  <div className="flex flex-wrap gap-2">
                    {(q.data.kb_ids || []).slice(0, 4).map((kbId) => (
                      <Link
                        key={kbId}
                        className="rounded border border-border/60 bg-muted/30 px-2 py-0.5 font-mono text-xs hover:bg-muted"
                        to={q.data.app_id
                          ? `/kbs/${encodeURIComponent(kbId)}?app_id=${encodeURIComponent(q.data.app_id)}`
                          : `/kbs/${encodeURIComponent(kbId)}`}
                        title={q.data.app_id ? "打开 KB（并保留 app 上下文）" : "打开该知识库"}
                      >
                        {kbId}
                      </Link>
                    ))}
                    {(q.data.kb_ids || []).length > 4 ? (
                      <span className="font-mono text-xs text-muted-foreground">+{(q.data.kb_ids || []).length - 4}</span>
                    ) : null}
                  </div>
                ) : (
                  <div className="font-mono text-xs">-</div>
                )}
              </div>
              <div className="lg:col-span-2">
                <div className="text-xs text-muted-foreground">request_id</div>
                <TraceLink
                  text={q.data.request_id}
                  textClassName="font-mono text-xs"
                  toastText="已复制 request_id"
                  to={`/observability?request_id=${encodeURIComponent(q.data.request_id)}`}
                  toLabel="去观测联查"
                />
              </div>
              <div className="lg:col-span-2">
                <div className="text-xs text-muted-foreground">conversation_id</div>
                <TraceLink
                  text={q.data.conversation_id}
                  textClassName="font-mono text-xs"
                  toastText="已复制 conversation_id"
                  to={`/observability?conversation_id=${encodeURIComponent(q.data.conversation_id)}`}
                  toLabel="去观测联查"
                />
              </div>
              <div>
                <div className="text-xs text-muted-foreground">message_id</div>
                <TraceLink
                  text={q.data.message_id}
                  textClassName="font-mono text-xs"
                  toastText="已复制 message_id"
                  to={`/observability?message_id=${encodeURIComponent(q.data.message_id)}`}
                  toLabel="去观测联查"
                />
              </div>
              <div>
                <div className="text-xs text-muted-foreground">question_len</div>
                <div className="font-mono text-xs">{q.data.question_len}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">retrieval_query_len</div>
                <div className="font-mono text-xs">{q.data.retrieval_query_len}</div>
              </div>
            </div>
          </Card>

          {q.data.error ? (
            <Card title="错误信息">
              <pre className="whitespace-pre-wrap break-words rounded-md border bg-muted p-3 text-xs text-destructive">
                {q.data.error}
              </pre>
            </Card>
          ) : null}

          <Card title="timings_ms">
            <JsonView value={q.data.timings_ms || {}} />
          </Card>
          <Card title="retrieval">
            <JsonView value={q.data.retrieval || {}} />
          </Card>
          <Card title="sources">
            <JsonView value={q.data.sources || {}} />
          </Card>
          <Card title="token_usage">
            <JsonView value={q.data.token_usage || {}} />
          </Card>
        </div>
      ) : null}
    </div>
  );
}
