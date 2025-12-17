import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { Card } from "../components/Card";
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
import { Badge } from "../components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { apiFetch } from "../lib/api";
import { useMe } from "../lib/useMe";

type KbsResp = { items: Array<{ id: string; name: string; status: string; updated_at: string | null }> };

export function KbsPage() {
  const me = useMe();
  const workspaceId = me.data?.workspace_id || "default";
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const q = useQuery({
    queryKey: ["kbs", workspaceId],
    queryFn: () => apiFetch<KbsResp>(`/admin/api/workspaces/${workspaceId}/kbs`),
    enabled: !!workspaceId,
  });

  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: async () => {
      return apiFetch<{ id: string }>(`/admin/api/workspaces/${workspaceId}/kbs`, {
        method: "POST",
        body: JSON.stringify({ name }),
      });
    },
    onSuccess: async () => {
      setName("");
      setCreateOpen(false);
      await qc.invalidateQueries({ queryKey: ["kbs", workspaceId] });
      toast.success("已创建知识库");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "创建失败"),
  });

  const errorText = useMemo(() => {
    if (!create.error) return "";
    return create.error instanceof Error ? create.error.message : String(create.error);
  }, [create.error]);

  const del = useMutation({
    mutationFn: async (kbId: string) => {
      return apiFetch<{ ok: boolean }>(`/admin/api/workspaces/${workspaceId}/kbs/${kbId}`, { method: "DELETE" });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["kbs", workspaceId] });
      toast.success("已删除知识库");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "删除失败"),
  });

  return (
    <div className="space-y-4">
      <div className="text-lg font-semibold">知识库</div>

      <Card title="列表" description="点击进入 KB 详情（数据源、Pages、统计、自检）">
        <div className="flex justify-end pb-3">
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Button>新建知识库</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>新建知识库（KB）</DialogTitle>
                <DialogDescription>KB（Knowledge Base）是知识集合，包含数据源、Pages 与 Chunks。</DialogDescription>
              </DialogHeader>
              <div className="space-y-2">
                <div className="text-xs text-muted-foreground">名称</div>
                <Input placeholder="例如 OneKey Docs KB" value={name} onChange={(e) => setName(e.target.value)} />
                {errorText ? <div className="text-sm text-destructive">{errorText}</div> : null}
              </div>
              <DialogFooter>
                <Button disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>
                  {create.isPending ? "创建中..." : "创建"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>

        {q.isLoading ? <div className="text-sm text-muted-foreground">加载中...</div> : null}
        {q.error ? <div className="text-sm text-destructive">{String(q.error)}</div> : null}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>更新时间</TableHead>
              <TableHead className="w-[180px]">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(q.data?.items || []).map((it) => (
              <TableRow key={it.id}>
                <TableCell>
                  <Link className="underline underline-offset-2" to={`/kbs/${it.id}`}>
                    {it.name}
                  </Link>
                  <div className="mt-1 font-mono text-xs text-muted-foreground">{it.id}</div>
                </TableCell>
                <TableCell>
                  <Badge variant={it.status === "active" ? "default" : "secondary"}>{it.status}</Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">{it.updated_at || "-"}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => navigate(`/kbs/${it.id}`)}>
                      详情
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="outline" size="sm" disabled={del.isPending}>
                          删除
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>确认删除知识库？</AlertDialogTitle>
                          <AlertDialogDescription>
                            将删除 KB=<span className="font-mono">{it.id}</span> 的记录与数据源/绑定关系（历史兼容：不会自动清理 pages/chunks）。
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
      </Card>
    </div>
  );
}
