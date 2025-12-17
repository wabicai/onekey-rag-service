import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { Card } from "../components/Card";
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
import { DataTable } from "../components/DataTable";
import { Badge } from "../components/ui/badge";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { apiFetch } from "../lib/api";
import { useMe } from "../lib/useMe";

type AppsResp = {
  items: Array<{ id: string; name: string; public_model_id: string; status: string; kb_count: number; updated_at: string | null }>;
};

export function AppsPage() {
  const me = useMe();
  const workspaceId = me.data?.workspace_id || "default";
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const q = useQuery({
    queryKey: ["apps", workspaceId],
    queryFn: () => apiFetch<AppsResp>(`/admin/api/workspaces/${workspaceId}/apps`),
    enabled: !!workspaceId,
  });

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
      toast.success("已创建 RagApp");
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "创建失败");
    },
  });

  const errorText = useMemo(() => {
    if (!create.error) return "";
    return create.error instanceof Error ? create.error.message : String(create.error);
  }, [create.error]);

  const columns: Array<ColumnDef<AppsResp["items"][number], unknown>> = useMemo(
    () => [
      { header: "名称", accessorKey: "name" },
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
      { header: "KB", accessorKey: "kb_count" },
      { header: "更新时间", accessorKey: "updated_at", cell: (ctx) => <span className="text-muted-foreground">{String(ctx.getValue() || "-")}</span> },
      {
        header: "操作",
        id: "actions",
        cell: (ctx) => {
          const row = ctx.row.original;
          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  操作
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem asChild>
                  <Link to={`/apps/${row.id}`}>查看详情</Link>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          );
        },
      },
    ],
    []
  );

  return (
    <div className="space-y-4">
      <div className="text-lg font-semibold">RagApp</div>

      <Card
        title="列表"
        description="每个 RagApp 对外暴露一个 model_id（public_model_id）；可绑定多个 KB 并配置 weight/priority"
        actions={
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Button>新建 App</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>新建 RagApp</DialogTitle>
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
                {errorText ? <div className="text-sm text-destructive">{errorText}</div> : null}
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
        {q.isLoading ? <div className="text-sm text-muted-foreground">加载中...</div> : null}
        {q.error ? <div className="text-sm text-destructive">{String(q.error)}</div> : null}
        <DataTable data={q.data?.items || []} columns={columns} />
      </Card>
    </div>
  );
}
