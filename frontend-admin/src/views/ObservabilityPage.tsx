import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { Card } from "../components/Card";
import { Pagination } from "../components/Pagination";
import { apiFetch } from "../lib/api";
import { useMe } from "../lib/useMe";

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
  }>;
};

function pickNumber(obj: Record<string, unknown> | undefined, key: string): number | null {
  if (!obj) return null;
  const v = obj[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function ObservabilityPage() {
  const me = useMe();
  const workspaceId = me.data?.workspace_id || "default";
  const [sp, setSp] = useSearchParams();

  const [page, setPage] = useState<number>(1);
  const [pageSize] = useState<number>(20);

  const [appId, setAppId] = useState<string>("");
  const [kbId, setKbId] = useState<string>("");
  const [conversationId, setConversationId] = useState<string>("");
  const [requestId, setRequestId] = useState<string>("");
  const [hasError, setHasError] = useState<string>(""); // "", "true", "false"
  const [dateRange, setDateRange] = useState<string>("24h");

  useEffect(() => {
    const rid = sp.get("request_id") || "";
    const cid = sp.get("conversation_id") || "";
    if (rid) setRequestId(rid);
    if (cid) setConversationId(cid);
  }, [sp]);

  const list = useQuery({
    queryKey: ["retrieval-events", workspaceId, page, pageSize, appId, kbId, conversationId, requestId, hasError, dateRange],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("page_size", String(pageSize));
      if (appId.trim()) params.set("app_id", appId.trim());
      if (kbId.trim()) params.set("kb_id", kbId.trim());
      if (conversationId.trim()) params.set("conversation_id", conversationId.trim());
      if (requestId.trim()) params.set("request_id", requestId.trim());
      if (hasError === "true") params.set("has_error", "true");
      if (hasError === "false") params.set("has_error", "false");
      if (dateRange) params.set("date_range", dateRange);
      return apiFetch<RetrievalEventsResp>(`/admin/api/workspaces/${workspaceId}/retrieval-events?${params.toString()}`);
    },
    enabled: !!workspaceId,
  });

  const actionError = useMemo(() => {
    if (!list.error) return "";
    return list.error instanceof Error ? list.error.message : String(list.error);
  }, [list.error]);

  return (
    <div className="space-y-4">
      <div className="text-lg font-semibold">观测（Retrieval Events）</div>

      {actionError ? <div className="text-sm text-red-400">{actionError}</div> : null}

      <Card title="筛选" description="仅存检索调试元数据（hash/len/chunk_ids/scores/timings），不存原文">
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-6">
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">app_id</div>
            <Input
              value={appId}
              onChange={(e) => {
                setPage(1);
                setAppId(e.target.value);
              }}
              placeholder="例如 app_default"
            />
          </div>
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">kb_id</div>
            <Input
              value={kbId}
              onChange={(e) => {
                setPage(1);
                setKbId(e.target.value);
              }}
              placeholder="例如 default"
            />
          </div>
          <div className="space-y-1 lg:col-span-2">
            <div className="text-xs text-muted-foreground">conversation_id</div>
            <Input
              value={conversationId}
              onChange={(e) => {
                setPage(1);
                setConversationId(e.target.value);
              }}
              placeholder="精确匹配"
            />
          </div>
          <div className="space-y-1 lg:col-span-2">
            <div className="text-xs text-muted-foreground">request_id</div>
            <Input
              value={requestId}
              onChange={(e) => {
                setPage(1);
                setRequestId(e.target.value);
              }}
              placeholder="chatcmpl_xxx"
            />
          </div>
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">has_error</div>
            <Select
              value={hasError}
              onChange={(e) => {
                setPage(1);
                setHasError(e.target.value);
              }}
            >
              <option value="">全部</option>
              <option value="true">true</option>
              <option value="false">false</option>
            </Select>
          </div>
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">时间范围</div>
            <Select
              value={dateRange}
              onChange={(e) => {
                setPage(1);
                setDateRange(e.target.value);
              }}
            >
              <option value="24h">24h</option>
              <option value="7d">7d</option>
              <option value="30d">30d</option>
            </Select>
          </div>
          <div className="flex items-end gap-2">
            <Button
              variant="outline"
              onClick={() => {
                const next = new URLSearchParams();
                if (requestId.trim()) next.set("request_id", requestId.trim());
                if (conversationId.trim()) next.set("conversation_id", conversationId.trim());
                setSp(next, { replace: true });
                list.refetch();
              }}
            >
              刷新
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setPage(1);
                setAppId("");
                setKbId("");
                setConversationId("");
                setRequestId("");
                setHasError("");
                setSp(new URLSearchParams(), { replace: true });
              }}
            >
              清空
            </Button>
          </div>
        </div>
      </Card>

      <Card title="列表" description="点击 event_id 查看详情（timings / chunk_ids / sources 等）">
        {list.isLoading ? <div className="text-sm text-muted-foreground">加载中...</div> : null}

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-2">event_id</th>
                <th className="py-2">时间</th>
                <th className="py-2">app_id</th>
                <th className="py-2">kb_ids</th>
                <th className="py-2">request_id</th>
                <th className="py-2">total_ms</th>
                <th className="py-2">error</th>
              </tr>
            </thead>
            <tbody>
              {(list.data?.items || []).map((it) => {
                const totalMs = pickNumber(it.timings_ms || {}, "total") ?? pickNumber(it.timings_ms || {}, "total_prepare");
                return (
                  <tr key={it.id} className="border-t align-top">
                    <td className="py-2 font-mono text-xs">
                      <Link className="underline underline-offset-2" to={`/observability/retrieval-events/${it.id}`}>
                        {it.id}
                      </Link>
                    </td>
                    <td className="py-2 font-mono text-xs text-muted-foreground">{it.created_at || "-"}</td>
                    <td className="py-2 font-mono text-xs">{it.app_id || "-"}</td>
                    <td className="py-2 font-mono text-xs">{(it.kb_ids || []).join(",")}</td>
                    <td className="py-2 font-mono text-xs">{it.request_id}</td>
                    <td className="py-2 font-mono text-xs">{totalMs != null ? totalMs : "-"}</td>
                    <td className="py-2">{it.has_error ? <span className="text-red-300">yes</span> : <span className="text-muted-foreground">no</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <Pagination
          page={list.data?.page || page}
          pageSize={list.data?.page_size || pageSize}
          total={list.data?.total || 0}
          onPageChange={(p) => setPage(p)}
        />
      </Card>
    </div>
  );
}
