import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { Card } from "../components/Card";
import { Pagination } from "../components/Pagination";
import { apiFetch } from "../lib/api";
import { useMe } from "../lib/useMe";

type AppsResp = { items: Array<{ id: string; name: string; public_model_id: string }> };
type FeedbackResp = {
  page: number;
  page_size: number;
  total: number;
  items: Array<{
    id: number;
    app_id: string;
    conversation_id: string;
    message_id: string;
    rating: string;
    reason: string;
    comment: string;
    sources: Record<string, unknown>;
    created_at: string | null;
  }>;
};

export function FeedbackPage() {
  const me = useMe();
  const workspaceId = me.data?.workspace_id || "default";

  const apps = useQuery({
    queryKey: ["apps", workspaceId],
    queryFn: () => apiFetch<AppsResp>(`/admin/api/workspaces/${workspaceId}/apps`),
    enabled: !!workspaceId,
  });

  const [page, setPage] = useState<number>(1);
  const [pageSize] = useState<number>(20);
  const [appId, setAppId] = useState<string>("");
  const [rating, setRating] = useState<string>("");
  const [reason, setReason] = useState<string>("");
  const [dateRange, setDateRange] = useState<string>("24h");

  const list = useQuery({
    queryKey: ["feedback", workspaceId, page, pageSize, appId, rating, reason, dateRange],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("page_size", String(pageSize));
      if (appId) params.set("app_id", appId);
      if (rating) params.set("rating", rating);
      if (reason.trim()) params.set("reason", reason.trim());
      if (dateRange) params.set("date_range", dateRange);
      return apiFetch<FeedbackResp>(`/admin/api/workspaces/${workspaceId}/feedback?${params.toString()}`);
    },
    enabled: !!workspaceId,
  });

  return (
    <div className="space-y-4">
      <div className="text-lg font-semibold">反馈</div>

      <Card title="筛选" description="rating/reason/app 过滤；message_id 通常可用于关联检索事件（request_id）">
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-6">
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">App</div>
            <Select
              value={appId}
              onChange={(e) => {
                setPage(1);
                setAppId(e.target.value);
              }}
            >
              <option value="">全部</option>
              {(apps.data?.items || []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.public_model_id})
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">rating</div>
            <Select
              value={rating}
              onChange={(e) => {
                setPage(1);
                setRating(e.target.value);
              }}
            >
              <option value="">全部</option>
              <option value="up">up</option>
              <option value="down">down</option>
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
          <div className="space-y-1 lg:col-span-2">
            <div className="text-xs text-muted-foreground">reason（精确匹配）</div>
            <Input
              value={reason}
              onChange={(e) => {
                setPage(1);
                setReason(e.target.value);
              }}
              placeholder="例如 hallucination / not_helpful"
            />
          </div>
          <div className="flex items-end">
            <Button variant="outline" onClick={() => list.refetch()}>
              刷新
            </Button>
          </div>
        </div>
      </Card>

      <Card title="列表" description="后续可扩展：标注、归因、运营看板、评测集回归">
        {list.isLoading ? <div className="text-sm text-muted-foreground">加载中...</div> : null}
        {list.error ? <div className="text-sm text-destructive">{String(list.error)}</div> : null}

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-2">时间</th>
                <th className="py-2">App</th>
                <th className="py-2">rating</th>
                <th className="py-2">reason</th>
                <th className="py-2">comment</th>
                <th className="py-2">conversation_id</th>
                <th className="py-2">message_id</th>
                <th className="py-2">联查</th>
              </tr>
            </thead>
            <tbody>
              {(list.data?.items || []).map((it) => (
                <tr key={it.id} className="border-t align-top">
                  <td className="py-2 font-mono text-xs text-muted-foreground">{it.created_at || "-"}</td>
                  <td className="py-2 font-mono text-xs">{it.app_id || "-"}</td>
                  <td className="py-2">
                    <span className={it.rating === "down" ? "text-red-300" : "text-emerald-300"}>{it.rating}</span>
                  </td>
                  <td className="py-2">{it.reason || <span className="text-muted-foreground">-</span>}</td>
                  <td className="py-2 max-w-[260px] break-words">{it.comment || <span className="text-muted-foreground">-</span>}</td>
                  <td className="py-2 font-mono text-xs">{it.conversation_id}</td>
                  <td className="py-2 font-mono text-xs">{it.message_id}</td>
                  <td className="py-2">
                    <Link
                      className="underline underline-offset-2"
                      to={`/observability?request_id=${encodeURIComponent(it.message_id)}`}
                    >
                      检索事件
                    </Link>
                  </td>
                </tr>
              ))}
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
