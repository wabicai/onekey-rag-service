import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Textarea } from "../components/ui/textarea";
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

type KbDetail = {
  id: string;
  name: string;
  description: string;
  status: string;
  config: Record<string, unknown>;
  created_at: string | null;
  updated_at: string | null;
};

type KbStats = {
  kb_id: string;
  pages: { total: number; last_crawled_at: string | null };
  chunks: { total: number; with_embedding: number; embedding_coverage: number };
};

type SourcesResp = {
  items: Array<{
    id: string;
    type: string;
    name: string;
    status: string;
    config: Record<string, unknown>;
    created_at: string | null;
    updated_at: string | null;
  }>;
};

function safeJsonParse(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const raw = (text || "").trim();
  if (!raw) return { ok: true, value: {} };
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) return { ok: true, value: v as Record<string, unknown> };
    return { ok: false, error: "必须是 JSON 对象（object）" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function KbDetailPage() {
  const me = useMe();
  const workspaceId = me.data?.workspace_id || "default";
  const params = useParams();
  const kbId = params.kbId || "";
  const navigate = useNavigate();
  const qc = useQueryClient();

  const kb = useQuery({
    queryKey: ["kb", workspaceId, kbId],
    queryFn: () => apiFetch<KbDetail>(`/admin/api/workspaces/${workspaceId}/kbs/${kbId}`),
    enabled: !!workspaceId && !!kbId,
  });

  const stats = useQuery({
    queryKey: ["kb-stats", workspaceId, kbId],
    queryFn: () => apiFetch<KbStats>(`/admin/api/workspaces/${workspaceId}/kbs/${kbId}/stats`),
    enabled: !!workspaceId && !!kbId,
  });

  const sources = useQuery({
    queryKey: ["sources", workspaceId, kbId],
    queryFn: () => apiFetch<SourcesResp>(`/admin/api/workspaces/${workspaceId}/kbs/${kbId}/sources`),
    enabled: !!workspaceId && !!kbId,
  });

  // ======== KB 编辑 ========
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState("active");
  const [configText, setConfigText] = useState("{}");
  const [configError, setConfigError] = useState("");

  useEffect(() => {
    if (!kb.data) return;
    if (draftLoaded) return;
    setDraftLoaded(true);
    setName(kb.data.name || "");
    setDescription(kb.data.description || "");
    setStatus(kb.data.status || "active");
    setConfigText(JSON.stringify(kb.data.config || {}, null, 2));
  }, [kb.data, draftLoaded]);

  const saveKb = useMutation({
    mutationFn: async () => {
      const parsed = safeJsonParse(configText);
      if (!parsed.ok) {
        setConfigError(parsed.error);
        throw new Error(parsed.error);
      }
      setConfigError("");
      return apiFetch<{ ok: boolean }>(`/admin/api/workspaces/${workspaceId}/kbs/${kbId}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: name.trim() || undefined,
          description: description || undefined,
          status: status || undefined,
          config: parsed.value,
        }),
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["kb", workspaceId, kbId] });
      await qc.invalidateQueries({ queryKey: ["kbs", workspaceId] });
      toast.success("已保存知识库");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "保存失败"),
  });

  const deleteKb = useMutation({
    mutationFn: async () => {
      return apiFetch<{ ok: boolean }>(`/admin/api/workspaces/${workspaceId}/kbs/${kbId}`, { method: "DELETE" });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["kbs", workspaceId] });
      toast.success("已删除知识库");
      navigate("/kbs", { replace: true });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "删除失败"),
  });

  // ======== Source 创建 ========
  const [newSourceType, setNewSourceType] = useState("crawler_site");
  const [newSourceName, setNewSourceName] = useState("");
  const [newSourceStatus, setNewSourceStatus] = useState("active");
  const [newSourceConfigText, setNewSourceConfigText] = useState(
    JSON.stringify(
      {
        base_url: "",
        sitemap_url: "",
        seed_urls: [],
        include_patterns: [],
        exclude_patterns: [],
        max_pages: 2000,
      },
      null,
      2
    )
  );
  const [newSourceConfigError, setNewSourceConfigError] = useState("");

  const createSource = useMutation({
    mutationFn: async () => {
      const parsed = safeJsonParse(newSourceConfigText);
      if (!parsed.ok) {
        setNewSourceConfigError(parsed.error);
        throw new Error(parsed.error);
      }
      setNewSourceConfigError("");
      return apiFetch<{ id: string }>(`/admin/api/workspaces/${workspaceId}/kbs/${kbId}/sources`, {
        method: "POST",
        body: JSON.stringify({
          type: newSourceType,
          name: newSourceName.trim(),
          status: newSourceStatus,
          config: parsed.value,
        }),
      });
    },
    onSuccess: async () => {
      setNewSourceName("");
      await qc.invalidateQueries({ queryKey: ["sources", workspaceId, kbId] });
      toast.success("已创建数据源");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "创建失败"),
  });

  // ======== Source 编辑 ========
  const [editingId, setEditingId] = useState<string>("");
  const [editName, setEditName] = useState<string>("");
  const [editStatus, setEditStatus] = useState<string>("active");
  const [editConfigText, setEditConfigText] = useState<string>("{}");
  const [editConfigError, setEditConfigError] = useState<string>("");

  useEffect(() => {
    if (!editingId) return;
    const row = (sources.data?.items || []).find((x) => x.id === editingId);
    if (!row) return;
    setEditName(row.name || "");
    setEditStatus(row.status || "active");
    setEditConfigText(JSON.stringify(row.config || {}, null, 2));
    setEditConfigError("");
  }, [editingId, sources.data]);

  const updateSource = useMutation({
    mutationFn: async () => {
      const parsed = safeJsonParse(editConfigText);
      if (!parsed.ok) {
        setEditConfigError(parsed.error);
        throw new Error(parsed.error);
      }
      setEditConfigError("");
      return apiFetch<{ ok: boolean }>(`/admin/api/workspaces/${workspaceId}/kbs/${kbId}/sources/${editingId}`, {
        method: "PATCH",
        body: JSON.stringify({ name: editName.trim() || undefined, status: editStatus, config: parsed.value }),
      });
    },
    onSuccess: async () => {
      setEditingId("");
      await qc.invalidateQueries({ queryKey: ["sources", workspaceId, kbId] });
      toast.success("已保存数据源");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "保存失败"),
  });

  const deleteSource = useMutation({
    mutationFn: async (sourceId: string) => {
      return apiFetch<{ ok: boolean }>(`/admin/api/workspaces/${workspaceId}/kbs/${kbId}/sources/${sourceId}`, { method: "DELETE" });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["sources", workspaceId, kbId] });
      toast.success("已删除数据源");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "删除失败"),
  });

  const actionError = useMemo(() => {
    const err = saveKb.error || deleteKb.error || createSource.error || updateSource.error || deleteSource.error;
    if (!err) return "";
    return err instanceof Error ? err.message : String(err);
  }, [saveKb.error, deleteKb.error, createSource.error, updateSource.error, deleteSource.error]);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-lg font-semibold">知识库详情</div>
          <div className="mt-1 text-xs text-muted-foreground">
            <Link className="underline underline-offset-2" to="/kbs">
              返回知识库列表
            </Link>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => navigate(`/pages?kb_id=${encodeURIComponent(kbId)}`)}>
            查看 Pages
          </Button>
          <Button variant="outline" onClick={() => navigate(`/jobs?kb_id=${encodeURIComponent(kbId)}`)}>
            去任务中心
          </Button>
        </div>
      </div>

      {actionError ? <div className="text-sm text-destructive">{actionError}</div> : null}

      {kb.isLoading ? <div className="text-sm text-muted-foreground">加载中...</div> : null}
      {kb.error ? <div className="text-sm text-destructive">{String(kb.error)}</div> : null}

      {kb.data ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card title="统计" description="Pages/Chunks/Embedding 覆盖率（用于运维看板）">
            {stats.isLoading ? <div className="text-sm text-muted-foreground">加载中...</div> : null}
            {stats.error ? <div className="text-sm text-destructive">{String(stats.error)}</div> : null}
            {stats.data ? (
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <div className="text-xs text-muted-foreground">Pages</div>
                  <div className="font-mono">{stats.data.pages.total}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Chunks</div>
                  <div className="font-mono">{stats.data.chunks.total}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">with_embedding</div>
                  <div className="font-mono">{stats.data.chunks.with_embedding}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">coverage</div>
                  <div className="font-mono">{Math.round((stats.data.chunks.embedding_coverage || 0) * 100)}%</div>
                </div>
                <div className="col-span-2">
                  <div className="text-xs text-muted-foreground">last_crawled_at</div>
                  <div className="font-mono text-xs">{stats.data.pages.last_crawled_at || "-"}</div>
                </div>
              </div>
            ) : null}
          </Card>

          <Card
            title="知识库配置（可编辑）"
            description="注意：删除 KB 不会自动清理 pages/chunks（历史兼容）"
            actions={
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" size="sm" disabled={deleteKb.isPending}>
                    删除 KB
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>确认删除知识库？</AlertDialogTitle>
                    <AlertDialogDescription>
                      将删除 KB=<span className="font-mono">{kbId}</span> 的记录与数据源/绑定关系（历史兼容：不会自动清理 pages/chunks）。
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>取消</AlertDialogCancel>
                    <AlertDialogAction onClick={() => deleteKb.mutate()}>继续删除</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            }
          >
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground">name</div>
                  <Input value={name} onChange={(e) => setName(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground">status</div>
                  <Select value={status} onChange={(e) => setStatus(e.target.value)}>
                    <option value="active">active</option>
                    <option value="disabled">disabled</option>
                  </Select>
                </div>
                <div className="space-y-1 lg:col-span-2">
                  <div className="text-xs text-muted-foreground">description</div>
                  <Textarea value={description} onChange={(e) => setDescription(e.target.value)} className="min-h-[80px]" />
                </div>
                <div className="space-y-1 lg:col-span-2">
                  <div className="text-xs text-muted-foreground">config（JSON）</div>
                  <Textarea value={configText} onChange={(e) => setConfigText(e.target.value)} className="min-h-[140px] font-mono text-xs" />
                  {configError ? <div className="text-xs text-destructive">{configError}</div> : null}
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Button disabled={saveKb.isPending} onClick={() => saveKb.mutate()}>
                  {saveKb.isPending ? "保存中..." : "保存"}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setDraftLoaded(false);
                    setConfigError("");
                  }}
                >
                  重置为服务端
                </Button>
              </div>
            </div>
          </Card>

          <Card title="数据源（Sources）" description="crawler_site 等连接器配置；抓取任务可覆盖 config">
            <div className="space-y-3">
              <div className="rounded-md border bg-muted/50 p-3">
                <div className="mb-2 text-sm font-semibold">新建 Source</div>
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                  <div className="space-y-1">
                    <div className="text-xs text-muted-foreground">type</div>
                    <Select value={newSourceType} onChange={(e) => setNewSourceType(e.target.value)}>
                      <option value="crawler_site">crawler_site</option>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <div className="text-xs text-muted-foreground">status</div>
                    <Select value={newSourceStatus} onChange={(e) => setNewSourceStatus(e.target.value)}>
                      <option value="active">active</option>
                      <option value="disabled">disabled</option>
                    </Select>
                  </div>
                  <div className="space-y-1 lg:col-span-2">
                    <div className="text-xs text-muted-foreground">name</div>
                    <Input value={newSourceName} onChange={(e) => setNewSourceName(e.target.value)} placeholder="例如 OneKey Docs Crawler" />
                  </div>
                  <div className="space-y-1 lg:col-span-2">
                    <div className="text-xs text-muted-foreground">config（JSON）</div>
                    <Textarea value={newSourceConfigText} onChange={(e) => setNewSourceConfigText(e.target.value)} className="min-h-[160px] font-mono text-xs" />
                    {newSourceConfigError ? <div className="text-xs text-destructive">{newSourceConfigError}</div> : null}
                  </div>
                </div>
                <div className="mt-2">
                  <Button disabled={!newSourceName.trim() || createSource.isPending} onClick={() => createSource.mutate()}>
                    {createSource.isPending ? "创建中..." : "创建"}
                  </Button>
                </div>
              </div>

              {sources.isLoading ? <div className="text-sm text-muted-foreground">加载中...</div> : null}
              {sources.error ? <div className="text-sm text-destructive">{String(sources.error)}</div> : null}

              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[220px]">id</TableHead>
                    <TableHead>name</TableHead>
                    <TableHead className="w-[140px]">type</TableHead>
                    <TableHead className="w-[140px]">status</TableHead>
                    <TableHead className="w-[200px]">updated_at</TableHead>
                    <TableHead className="w-[220px]">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(sources.data?.items || []).map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="font-mono text-xs">{s.id}</TableCell>
                      <TableCell>{s.name}</TableCell>
                      <TableCell className="font-mono text-xs">{s.type}</TableCell>
                      <TableCell>{s.status}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">{s.updated_at || "-"}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Button variant="outline" size="sm" onClick={() => setEditingId(s.id)}>
                            编辑
                          </Button>
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button variant="outline" size="sm" disabled={deleteSource.isPending}>
                                删除
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>确认删除数据源？</AlertDialogTitle>
                                <AlertDialogDescription>
                                  将删除 source_id=<span className="font-mono">{s.id}</span>（不影响已抓取的 pages/chunks）。
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>取消</AlertDialogCancel>
                                <AlertDialogAction onClick={() => deleteSource.mutate(s.id)}>继续删除</AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                  {!sources.data?.items?.length ? (
                    <TableRow>
                      <TableCell className="text-sm text-muted-foreground" colSpan={6}>
                        暂无数据源
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </div>
          </Card>

          <Card title="Source 配置（编辑器）" description="一次只编辑一个 Source；保存后会覆盖 config">
            {!editingId ? (
              <div className="text-sm text-muted-foreground">请选择上方列表中的 Source 点击“编辑”</div>
            ) : (
              <div className="space-y-3">
                <div className="text-sm">
                  正在编辑：<span className="font-mono">{editingId}</span>
                </div>
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                  <div className="space-y-1">
                    <div className="text-xs text-muted-foreground">name</div>
                    <Input value={editName} onChange={(e) => setEditName(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <div className="text-xs text-muted-foreground">status</div>
                    <Select value={editStatus} onChange={(e) => setEditStatus(e.target.value)}>
                      <option value="active">active</option>
                      <option value="disabled">disabled</option>
                    </Select>
                  </div>
                  <div className="space-y-1 lg:col-span-2">
                    <div className="text-xs text-muted-foreground">config（JSON）</div>
                    <Textarea value={editConfigText} onChange={(e) => setEditConfigText(e.target.value)} className="min-h-[220px] font-mono text-xs" />
                    {editConfigError ? <div className="text-xs text-destructive">{editConfigError}</div> : null}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button disabled={updateSource.isPending} onClick={() => updateSource.mutate()}>
                    {updateSource.isPending ? "保存中..." : "保存"}
                  </Button>
                  <Button variant="outline" onClick={() => setEditingId("")}>
                    取消
                  </Button>
                </div>
              </div>
            )}
          </Card>

          <Card title="调试（只读）" description="服务端返回原始 JSON">
            <JsonView value={{ kb: kb.data, stats: stats.data, sources: sources.data }} defaultCollapsed />
          </Card>
        </div>
      ) : null}
    </div>
  );
}
