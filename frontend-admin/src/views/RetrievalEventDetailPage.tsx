import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";

import { Card } from "../components/Card";
import { JsonView } from "../components/JsonView";
import { apiFetch } from "../lib/api";
import { useMe } from "../lib/useMe";

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
  const me = useMe();
  const workspaceId = me.data?.workspace_id || "default";
  const params = useParams();
  const eventId = Number(params.eventId || 0);

  const q = useQuery({
    queryKey: ["retrieval-event", workspaceId, eventId],
    queryFn: () => apiFetch<RetrievalEventDetail>(`/admin/api/workspaces/${workspaceId}/retrieval-events/${eventId}`),
    enabled: !!workspaceId && Number.isFinite(eventId) && eventId > 0,
  });

  return (
    <div className="space-y-4">
      <div>
        <div className="text-lg font-semibold">检索事件详情</div>
        <div className="mt-1 text-xs text-muted-foreground">
          <Link className="underline underline-offset-2" to="/observability">
            返回列表
          </Link>
        </div>
      </div>

      {q.isLoading ? <div className="text-sm text-muted-foreground">加载中...</div> : null}
      {q.error ? <div className="text-sm text-destructive">{String(q.error)}</div> : null}

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
                <div className="font-mono text-xs">{q.data.app_id || "-"}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">kb_ids</div>
                <div className="font-mono text-xs">{(q.data.kb_ids || []).join(",")}</div>
              </div>
              <div className="lg:col-span-2">
                <div className="text-xs text-muted-foreground">request_id</div>
                <div className="font-mono text-xs">{q.data.request_id}</div>
              </div>
              <div className="lg:col-span-2">
                <div className="text-xs text-muted-foreground">conversation_id</div>
                <div className="font-mono text-xs">{q.data.conversation_id}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">message_id</div>
                <div className="font-mono text-xs">{q.data.message_id}</div>
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
