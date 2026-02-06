import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { MoreHorizontal } from "lucide-react";

import { Card } from "../components/Card";
import { ConfirmDangerDialog } from "../components/ConfirmDangerDialog";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { DataTable } from "../components/DataTable";
import { Badge } from "../components/ui/badge";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { EmptyState } from "../components/EmptyState";
import { ApiErrorBanner } from "../components/ApiErrorBanner";
import { FilterChips, type FilterChip } from "../components/FilterChips";
import { Pagination } from "../components/Pagination";
import { apiFetch } from "../lib/api";
import { useWorkspace } from "../lib/workspace";

type AppsResp = {
  items: Array<{ id: string; name: string; public_model_id: string; status: string; kb_count: number; updated_at: string | null }>;
};

export function AppsPage() {
  const { workspaceId } = useWorkspace();
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [sp, setSp] = useSearchParams();
  const q = useQuery({
    queryKey: ["apps", workspaceId],
    queryFn: () => apiFetch<AppsResp>(`/admin/api/workspaces/${workspaceId}/apps`),
    enabled: !!workspaceId,
  });

  // 允许从 Dashboard / 其他页面通过 ?create=1 直接打开创建对话框
  const createParam = (sp.get("create") || "").trim();
  useEffect(() => {
    if (createParam !== "1") return;
    setCreateOpen(true);
    const next = new URLSearchParams(sp);
    next.delete("create");
    setSp(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createParam]);

  const pageSize = 20;
  const page = Math.max(1, Number.parseInt(sp.get("page") || "1", 10) || 1);
  const searchQ = (sp.get("q") || "").trim();
  const sort = (sp.get("sort") || "updated_at_desc").trim();

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
    searchQ ? { key: "q", label: "搜索", value: searchQ, onRemove: () => updateFilter([["q", null]]) } : null,
    sort && sort !== "updated_at_desc" ? { key: "sort", label: "排序", value: sort, onRemove: () => updateFilter([["sort", null]]) } : null,
  ].filter(Boolean) as FilterChip[];

  const [name, setName] = useState("");
  const [publicModelId, setPublicModelId] = useState("");

  const create = useMutation({
    mutationFn: async () => {
      return apiFetch<{ id: string }>(`/admin/api/workspaces/${workspaceId}/apps`, {
        method: "POST",
        body: JSON.stringify({ name, public_model_id: publicModelId || undefined }),
      });
    },
    onSuccess: async () => {
      setName("");
      setPublicModelId("");
      setCreateOpen(false);
      await qc.invalidateQueries({ queryKey: ["apps", workspaceId] });
      toast.success("已创建应用");
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "创建失败");
    },
  });

  const updateStatus = useMutation({
    mutationFn: async (args: { app_id: string; status: string }) => {
      return apiFetch<{ ok: boolean }>(`/admin/api/workspaces/${workspaceId}/apps/${args.app_id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: args.status }),
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["apps", workspaceId] });
      toast.success("已更新应用状态");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "更新失败"),
  });

  async function copyText(text: string, okText: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(okText);
    } catch {
      toast.error("复制失败");
    }
  }

  const columns: Array<ColumnDef<AppsResp["items"][number], unknown>> = useMemo(
    () => [
      {
        header: "名称",
        accessorKey: "name",
        cell: (ctx) => {
          const row = ctx.row.original;
          return (
            <Link className="font-medium hover:underline" to={`/apps/${encodeURIComponent(row.id)}`}>
              {String(ctx.getValue() || "")}
            </Link>
          );
        },
      },
      {
        header: "model_id",
        accessorKey: "public_model_id",
        cell: (ctx) => <span className="font-mono text-xs">{String(ctx.getValue() || "")}</span>,
      },
      {
        header: "状态",
        accessorKey: "status",
        cell: (ctx) => {
          const v = String(ctx.getValue() || "");
          const variant = v === "published" ? "default" : v === "draft" ? "secondary" : v === "disabled" ? "destructive" : "outline";
          return <Badge variant={variant as any}>{v || "-"}</Badge>;
        },
      },
      {
        header: "KB",
        accessorKey: "kb_count",
        cell: (ctx) => {
          const row = ctx.row.original;
          const n = Number(ctx.getValue() || 0) || 0;
          return n > 0 ? (
            <Link className="font-mono text-xs underline underline-offset-2" to={`/kbs?app_id=${encodeURIComponent(row.id)}`}>
              {n}
            </Link>
          ) : (
            <span className="font-mono text-xs text-muted-foreground">0</span>
          );
        },
      },
      { header: "更新时间", accessorKey: "updated_at", cell: (ctx) => <span className="text-muted-foreground">{String(ctx.getValue() || "-")}</span> },
      {
        header: "操作",
        id: "actions",
        cell: (ctx) => {
          const row = ctx.row.original;
          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" className="h-8 w-8" aria-label="更多操作" title="更多操作">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem asChild>
                  <Link to={`/apps/${encodeURIComponent(row.id)}`}>查看详情</Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to={`/kbs?app_id=${encodeURIComponent(row.id)}`}>查看关联 KB</Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to={`/jobs?app_id=${encodeURIComponent(row.id)}`}>运行中心（按应用）</Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to={`/observability?app_id=${encodeURIComponent(row.id)}`}>观测（按应用）</Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={(e) => {
                    e.preventDefault();
                    void copyText(row.id, "已复制应用ID");
                  }}
                >
                  复制应用ID
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!row.public_model_id}
                  onSelect={(e) => {
                    e.preventDefault();
                    void copyText(row.public_model_id, "已复制 public_model_id");
                  }}
                >
                  复制 public_model_id
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {row.status === "disabled" ? (
                  <DropdownMenuItem
                    disabled={updateStatus.isPending}
                    onSelect={(e) => {
                      e.preventDefault();
                      updateStatus.mutate({ app_id: row.id, status: "published" });
                    }}
                  >
                    启用
                  </DropdownMenuItem>
                ) : (
                  <ConfirmDangerDialog
                    trigger={<DropdownMenuItem disabled={updateStatus.isPending}>禁用</DropdownMenuItem>}
                    title="确认禁用应用？"
                    description={
                      <>
                        将把 app_id=<span className="font-mono">{row.id}</span> 状态设为 <span className="font-mono">disabled</span>。
                      </>
                    }
                    confirmLabel="继续禁用"
                    confirmVariant="destructive"
                    confirmText={row.id}
                    confirmPlaceholder="输入应用ID确认"
                    confirmDisabled={updateStatus.isPending}
                    onConfirm={() => updateStatus.mutateAsync({ app_id: row.id, status: "disabled" })}
                  />
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          );
        },
      },
    ],
    [updateStatus.isPending]
  );

  const filteredSorted = useMemo(() => {
    const raw = q.data?.items || [];
    const qLower = searchQ.toLowerCase();
    const filtered = qLower
      ? raw.filter((a) => (a.name || "").toLowerCase().includes(qLower) || (a.public_model_id || "").toLowerCase().includes(qLower))
      : raw;
    const sorted = [...filtered];
    if (sort === "updated_at_asc") {
      sorted.sort((a, b) => String(a.updated_at || "").localeCompare(String(b.updated_at || "")));
    } else {
      sorted.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
    }
    return sorted;
  }, [q.data, searchQ, sort]);

  const total = filteredSorted.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pageCount);
  const pageItems = filteredSorted.slice((safePage - 1) * pageSize, safePage * pageSize);

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-border/70 bg-gradient-to-br from-card/90 via-card/70 to-background p-6 shadow-lg shadow-black/30">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-xs tracking-wider text-primary">应用</div>
            <div className="text-2xl font-semibold text-foreground">应用</div>
            <div className="text-sm text-muted-foreground">管理对外 model_id（public_model_id），并绑定知识库（KB）与检索策略。</div>
          </div>
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link to="/kbs">知识库</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/observability">观测</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/settings">设置</Link>
            </Button>
          </div>
        </div>
      </div>

      <Card
        title="列表"
        description="每个应用对外暴露一个 model_id（public_model_id）；可绑定多个知识库并配置 weight/priority"
        actions={
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Button>新建应用</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>新建应用</DialogTitle>
                <DialogDescription>创建后可在详情页绑定知识库、配置模型与检索策略。</DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground">名称</div>
                  <Input placeholder="例如 OneKey Docs" value={name} onChange={(e) => setName(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground">对外 model_id（可选）</div>
                  <Input placeholder="例如 onekey-docs" value={publicModelId} onChange={(e) => setPublicModelId(e.target.value)} />
                </div>
                {create.error ? <ApiErrorBanner error={create.error} /> : null}
              </div>
              <DialogFooter>
                <Button
                  disabled={!name.trim() || create.isPending}
                  onClick={() => create.mutate()}
                >
                  {create.isPending ? "创建中..." : "创建"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        }
      >
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[240px] flex-1 space-y-1">
            <div className="text-xs text-muted-foreground">搜索（name / public_model_id）</div>
            <Input value={searchQ} onChange={(e) => updateFilter([["q", e.target.value]])} placeholder="例如 OneKey / onekey-docs" />
          </div>
          <div className="w-[220px] space-y-1">
            <div className="text-xs text-muted-foreground">排序</div>
            <Select value={sort} onChange={(e) => updateFilter([["sort", e.target.value]])}>
              <option value="updated_at_desc">updated_at ↓</option>
              <option value="updated_at_asc">updated_at ↑</option>
            </Select>
          </div>
          <Button variant="outline" onClick={() => setSp(new URLSearchParams(), { replace: true })}>
            清空
          </Button>
        </div>
        <FilterChips items={chips} className="pt-3" />

        {q.isLoading ? <div className="text-sm text-muted-foreground">加载中...</div> : null}
        {q.error ? <ApiErrorBanner error={q.error} /> : null}
        <DataTable
          data={pageItems}
          columns={columns}
          empty={
            <EmptyState
              description={
                  <div className="space-y-2">
                    <div>快速开始：</div>
                    <ol className="list-inside list-decimal text-left">
                      <li>新建应用</li>
                      <li>进入应用详情绑定知识库（KB）</li>
                      <li>进入知识库详情，在「数据源/运行」中触发采集与构建索引</li>
                      <li>在客户端/Widget 调试后发布</li>
                    </ol>
                  </div>
                }
              actions={
                <Button type="button" onClick={() => setCreateOpen(true)}>
                  新建应用
                </Button>
              }
            />
          }
        />
        <Pagination
          page={safePage}
          pageSize={pageSize}
          total={total}
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
