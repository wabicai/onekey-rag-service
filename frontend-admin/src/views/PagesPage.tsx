import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";

import { Button } from "../components/ui/button";
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
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Card } from "../components/Card";
import { Pagination } from "../components/Pagination";
import { apiFetch } from "../lib/api";
import { useMe } from "../lib/useMe";

type KbsResp = { items: Array<{ id: string; name: string }> };
type PagesResp = {
  page: number;
  page_size: number;
  total: number;
  items: Array<{
    id: number;
    kb_id: string;
    source_id: string;
    url: string;
    title: string;
    http_status: number;
    last_crawled_at: string | null;
    indexed: boolean;
    changed: boolean;
  }>;
};

export function PagesPage() {
  const me = useMe();
  const workspaceId = me.data?.workspace_id || "default";
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [sp] = useSearchParams();

  const kbs = useQuery({
    queryKey: ["kbs", workspaceId],
    queryFn: () => apiFetch<KbsResp>(`/admin/api/workspaces/${workspaceId}/kbs`),
    enabled: !!workspaceId,
  });

  const [page, setPage] = useState<number>(1);
  const [pageSize] = useState<number>(20);
  const [kbId, setKbId] = useState<string>("");
  const [sourceId, setSourceId] = useState<string>("");
  const [indexed, setIndexed] = useState<string>(""); // "", "true", "false"
  const [q, setQ] = useState<string>("");
  const [httpStatus, setHttpStatus] = useState<string>("");
  const [changedOnly, setChangedOnly] = useState<boolean>(false);

  useEffect(() => {
    const qKb = (sp.get("kb_id") || "").trim();
    if (!qKb) return;
    setKbId(qKb);
  }, [sp]);

  const listQuery = useQuery({
    queryKey: ["pages", workspaceId, page, pageSize, kbId, sourceId, indexed, q, httpStatus, changedOnly],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("page_size", String(pageSize));
      if (kbId) params.set("kb_id", kbId);
      if (sourceId.trim()) params.set("source_id", sourceId.trim());
      if (indexed === "true") params.set("indexed", "true");
      if (indexed === "false") params.set("indexed", "false");
      if (q.trim()) params.set("q", q.trim());
      if (httpStatus.trim()) params.set("http_status", httpStatus.trim());
      if (changedOnly) params.set("changed", "true");
      return apiFetch<PagesResp>(`/admin/api/workspaces/${workspaceId}/pages?${params.toString()}`);
    },
    enabled: !!workspaceId,
  });

  const recrawl = useMutation({
    mutationFn: async (pageId: number) => {
      return apiFetch<{ job_id: string }>(`/admin/api/workspaces/${workspaceId}/pages/${pageId}/recrawl`, { method: "POST" });
    },
    onSuccess: async (data) => {
      await qc.invalidateQueries({ queryKey: ["pages", workspaceId] });
      toast.success("已触发 recrawl");
      navigate(`/jobs/${data.job_id}`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "触发失败"),
  });

  const del = useMutation({
    mutationFn: async (pageId: number) => {
      return apiFetch<{ ok: boolean }>(`/admin/api/workspaces/${workspaceId}/pages/${pageId}`, { method: "DELETE" });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["pages", workspaceId] });
      toast.success("已删除 Page");
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
      <div className="text-lg font-semibold">Pages</div>

      {actionError ? <div className="text-sm text-destructive">{actionError}</div> : null}

      <Card title="筛选" description="按 KB/关键字/HTTP 状态过滤；changed=true 表示 content_hash != indexed_content_hash">
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-6">
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">KB</div>
            <Select
              value={kbId}
              onChange={(e) => {
                setPage(1);
                setKbId(e.target.value);
              }}
            >
              <option value="">全部</option>
              {(kbs.data?.items || []).map((kb) => (
                <option key={kb.id} value={kb.id}>
                  {kb.name} ({kb.id})
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">source_id</div>
            <Input
              value={sourceId}
              onChange={(e) => {
                setPage(1);
                setSourceId(e.target.value);
              }}
              placeholder="例如 src_xxx"
            />
          </div>
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">indexed</div>
            <Select
              value={indexed}
              onChange={(e) => {
                setPage(1);
                setIndexed(e.target.value);
              }}
            >
              <option value="">全部</option>
              <option value="true">true</option>
              <option value="false">false</option>
            </Select>
          </div>
          <div className="space-y-1 lg:col-span-2">
            <div className="text-xs text-muted-foreground">q（URL/标题模糊匹配）</div>
            <Input
              value={q}
              onChange={(e) => {
                setPage(1);
                setQ(e.target.value);
              }}
              placeholder="例如 /connect 或 OneKey"
            />
          </div>
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">http_status</div>
            <Input
              value={httpStatus}
              onChange={(e) => {
                setPage(1);
                setHttpStatus(e.target.value);
              }}
              placeholder="例如 200"
            />
          </div>
          <div className="flex items-end gap-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={changedOnly}
                onChange={(e) => {
                  setPage(1);
                  setChangedOnly(e.target.checked);
                }}
              />
              只看 changed
            </label>
            <Button variant="outline" onClick={() => listQuery.refetch()}>
              刷新
            </Button>
          </div>
        </div>
      </Card>

      <Card title="列表" description="点击 ID 查看详情；支持单页 recrawl 与删除（谨慎）">
        {listQuery.isLoading ? <div className="text-sm text-muted-foreground">加载中...</div> : null}
        {listQuery.error ? <div className="text-sm text-destructive">{String(listQuery.error)}</div> : null}

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[90px]">ID</TableHead>
              <TableHead className="w-[160px]">KB</TableHead>
              <TableHead className="w-[180px]">Source</TableHead>
              <TableHead>标题</TableHead>
              <TableHead>URL</TableHead>
              <TableHead className="w-[80px]">HTTP</TableHead>
              <TableHead className="w-[90px]">indexed</TableHead>
              <TableHead className="w-[90px]">changed</TableHead>
              <TableHead className="w-[160px]">最后抓取</TableHead>
              <TableHead className="w-[240px]">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(listQuery.data?.items || []).map((it) => (
              <TableRow key={it.id}>
                <TableCell className="font-mono text-xs">
                  <Link className="underline underline-offset-2" to={`/pages/${it.id}`}>
                    {it.id}
                  </Link>
                </TableCell>
                <TableCell className="font-mono text-xs">{it.kb_id}</TableCell>
                <TableCell className="font-mono text-xs">{it.source_id || "-"}</TableCell>
                <TableCell>{it.title || <span className="text-muted-foreground">-</span>}</TableCell>
                <TableCell>
                  <a className="break-all underline underline-offset-2" href={it.url} target="_blank" rel="noreferrer">
                    {it.url}
                  </a>
                </TableCell>
                <TableCell>
                  <span className={it.http_status >= 400 ? "text-red-300" : ""}>{it.http_status || "-"}</span>
                </TableCell>
                <TableCell>{it.indexed ? <span className="text-emerald-300">yes</span> : <span className="text-muted-foreground">no</span>}</TableCell>
                <TableCell>{it.changed ? <span className="text-amber-300">yes</span> : <span className="text-muted-foreground">no</span>}</TableCell>
                <TableCell className="text-muted-foreground">{it.last_crawled_at || "-"}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => navigate(`/pages/${it.id}`)}>
                      详情
                    </Button>
                    <Button variant="outline" size="sm" disabled={recrawl.isPending} onClick={() => recrawl.mutate(it.id)}>
                      recrawl
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="outline" size="sm" disabled={del.isPending}>
                          删除
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>确认删除 Page？</AlertDialogTitle>
                          <AlertDialogDescription>
                            将删除 page_id=<span className="font-mono">{it.id}</span>（会级联删除 chunks）。此操作不可恢复。
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>取消</AlertDialogCancel>
                          <AlertDialogAction onClick={() => del.mutate(it.id)}>继续删除</AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        <Pagination
          page={listQuery.data?.page || page}
          pageSize={listQuery.data?.page_size || pageSize}
          total={listQuery.data?.total || 0}
          onPageChange={(p) => setPage(p)}
        />
      </Card>
    </div>
  );
}
