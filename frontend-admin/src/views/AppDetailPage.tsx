import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { toast } from "sonner";

import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Textarea } from "../components/ui/textarea";
import { Card } from "../components/Card";
import { JsonView } from "../components/JsonView";
import { apiFetch } from "../lib/api";
import { allocateTopK } from "../lib/kbAllocation";
import { useMe } from "../lib/useMe";

type AppDetail = {
  id: string;
  workspace_id: string;
  name: string;
  public_model_id: string;
  status: string;
  config: Record<string, unknown>;
  created_at: string | null;
  updated_at: string | null;
};

type AppKbsResp = {
  items: Array<{ kb_id: string; kb_name: string; weight: number; priority: number; enabled: boolean }>;
};

type KbsResp = { items: Array<{ id: string; name: string; status: string }> };
type WorkspaceSettings = { retrieval?: { rag_top_k?: number } };

function safeJsonParse(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const raw = (text || "").trim();
  if (!raw) return { ok: true, value: {} };
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) return { ok: true, value: v as Record<string, unknown> };
    return { ok: false, error: "config 必须是 JSON 对象（object）" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function AppDetailPage() {
  const me = useMe();
  const workspaceId = me.data?.workspace_id || "default";
  const params = useParams();
  const appId = params.appId || "";
  const qc = useQueryClient();

  const app = useQuery({
    queryKey: ["app", workspaceId, appId],
    queryFn: () => apiFetch<AppDetail>(`/admin/api/workspaces/${workspaceId}/apps/${appId}`),
    enabled: !!workspaceId && !!appId,
  });

  const bindings = useQuery({
    queryKey: ["app-kbs", workspaceId, appId],
    queryFn: () => apiFetch<AppKbsResp>(`/admin/api/workspaces/${workspaceId}/apps/${appId}/kbs`),
    enabled: !!workspaceId && !!appId,
  });

  const kbs = useQuery({
    queryKey: ["kbs", workspaceId],
    queryFn: () => apiFetch<KbsResp>(`/admin/api/workspaces/${workspaceId}/kbs`),
    enabled: !!workspaceId,
  });

  const settings = useQuery({
    queryKey: ["settings", workspaceId],
    queryFn: () => apiFetch<WorkspaceSettings>(`/admin/api/workspaces/${workspaceId}/settings`),
    enabled: !!workspaceId,
  });

  // ======== App 编辑 ========
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [name, setName] = useState("");
  const [publicModelId, setPublicModelId] = useState("");
  const [status, setStatus] = useState("published");
  const [configText, setConfigText] = useState("{}");
  const [configError, setConfigError] = useState("");

  useEffect(() => {
    if (!app.data) return;
    if (draftLoaded) return;
    setDraftLoaded(true);
    setName(app.data.name || "");
    setPublicModelId(app.data.public_model_id || "");
    setStatus(app.data.status || "published");
    setConfigText(JSON.stringify(app.data.config || {}, null, 2));
  }, [app.data, draftLoaded]);

  const saveApp = useMutation({
    mutationFn: async () => {
      const parsed = safeJsonParse(configText);
      if (!parsed.ok) {
        setConfigError(parsed.error);
        throw new Error(parsed.error);
      }
      setConfigError("");
      return apiFetch<{ ok: boolean }>(`/admin/api/workspaces/${workspaceId}/apps/${appId}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: name.trim() || undefined,
          public_model_id: publicModelId.trim() || undefined,
          status: status || undefined,
          config: parsed.value,
        }),
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["app", workspaceId, appId] });
      await qc.invalidateQueries({ queryKey: ["apps", workspaceId] });
      toast.success("已保存 RagApp");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "保存失败"),
  });

  // ======== 绑定编辑 ========
  type BindingDraft = { kb_id: string; kb_name?: string; weight: number; priority: number; enabled: boolean };
  const [bindingLoaded, setBindingLoaded] = useState(false);
  const [bindingDraft, setBindingDraft] = useState<BindingDraft[]>([]);
  const [kbToAdd, setKbToAdd] = useState<string>("");

  useEffect(() => {
    if (!bindings.data) return;
    if (bindingLoaded) return;
    setBindingLoaded(true);
    setBindingDraft(
      (bindings.data.items || []).map((b) => ({
        kb_id: b.kb_id,
        kb_name: b.kb_name,
        weight: Number(b.weight || 0),
        priority: Number(b.priority || 0),
        enabled: !!b.enabled,
      }))
    );
  }, [bindings.data, bindingLoaded]);

  useEffect(() => {
    if (kbToAdd) return;
    const first = (kbs.data?.items || []).find((x) => !(bindingDraft || []).some((b) => b.kb_id === x.id));
    if (first) setKbToAdd(first.id);
  }, [kbs.data, kbToAdd, bindingDraft]);

  const saveBindings = useMutation({
    mutationFn: async () => {
      const payload = {
        bindings: bindingDraft.map((b) => ({
          kb_id: b.kb_id,
          weight: Number(b.weight || 0),
          priority: Number(b.priority || 0),
          enabled: !!b.enabled,
        })),
      };
      return apiFetch<{ ok: boolean }>(`/admin/api/workspaces/${workspaceId}/apps/${appId}/kbs`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["app-kbs", workspaceId, appId] });
      await qc.invalidateQueries({ queryKey: ["apps", workspaceId] });
      toast.success("已保存绑定关系");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "保存失败"),
  });

  const enabledBindings = useMemo(() => bindingDraft.filter((b) => b.enabled && (b.kb_id || "").trim()), [bindingDraft]);
  const ragTopK = Number(settings.data?.retrieval?.rag_top_k || 0) || 0;
  const alloc = useMemo(() => allocateTopK(enabledBindings, ragTopK), [enabledBindings, ragTopK]);
  const allocMap = useMemo(() => new Map(alloc.map((a) => [a.kb_id, a.top_k])), [alloc]);

  const actionError = useMemo(() => {
    const err = saveApp.error || saveBindings.error;
    if (!err) return "";
    return err instanceof Error ? err.message : String(err);
  }, [saveApp.error, saveBindings.error]);

  return (
    <div className="space-y-4">
      <div>
        <div className="text-lg font-semibold">RagApp 详情</div>
        <div className="mt-1 text-xs text-muted-foreground">
          <Link className="underline underline-offset-2" to="/apps">
            返回 RagApp 列表
          </Link>
        </div>
      </div>

      {actionError ? <div className="text-sm text-destructive">{actionError}</div> : null}

      {app.isLoading ? <div className="text-sm text-muted-foreground">加载中...</div> : null}
      {app.error ? <div className="text-sm text-destructive">{String(app.error)}</div> : null}

      {app.data ? (
        <div className="space-y-4">
          <Card title="基本信息（可编辑）" description="修改后会影响 /v1/models 暴露与检索范围">
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">name</div>
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">public_model_id（对外 model）</div>
                <Input value={publicModelId} onChange={(e) => setPublicModelId(e.target.value)} />
              </div>
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">status</div>
                <Select
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                >
                  <option value="published">published</option>
                  <option value="draft">draft</option>
                  <option value="disabled">disabled</option>
                </Select>
              </div>
              <div className="space-y-1 lg:col-span-2">
                <div className="text-xs text-muted-foreground">config（JSON，可选）</div>
                <Textarea value={configText} onChange={(e) => setConfigText(e.target.value)} className="min-h-[160px] font-mono text-xs" />
                {configError ? <div className="text-xs text-destructive">{configError}</div> : null}
              </div>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <Button disabled={saveApp.isPending} onClick={() => saveApp.mutate()}>
                {saveApp.isPending ? "保存中..." : "保存"}
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
          </Card>

          <Card
            title="绑定知识库（多 KB + 权重/优先级）"
            description="语义：按 weight 分配各 KB 的 topK，再合并重排；priority 越小越优先"
            actions={
              <Button variant="outline" size="sm" onClick={() => bindings.refetch()}>
                刷新
              </Button>
            }
          >
            {bindings.isLoading ? <div className="text-sm text-muted-foreground">加载中...</div> : null}
            {bindings.error ? <div className="text-sm text-destructive">{String(bindings.error)}</div> : null}

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[90px]">enabled</TableHead>
                  <TableHead className="w-[180px]">kb_id</TableHead>
                  <TableHead>kb_name</TableHead>
                  <TableHead className="w-[140px]">weight</TableHead>
                  <TableHead className="w-[140px]">priority</TableHead>
                  <TableHead className="w-[140px]">topK（估算）</TableHead>
                  <TableHead className="w-[120px]">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {bindingDraft.map((b, idx) => (
                  <TableRow key={`${b.kb_id}_${idx}`}>
                    <TableCell>
                      <Checkbox
                        checked={b.enabled}
                        onCheckedChange={(v) => {
                          const next = [...bindingDraft];
                          next[idx] = { ...next[idx], enabled: !!v };
                          setBindingDraft(next);
                        }}
                      />
                    </TableCell>
                    <TableCell className="font-mono text-xs">{b.kb_id}</TableCell>
                    <TableCell>{b.kb_name || <span className="text-muted-foreground">-</span>}</TableCell>
                    <TableCell>
                      <Input
                        value={String(b.weight)}
                        onChange={(e) => {
                          const next = [...bindingDraft];
                          next[idx] = { ...next[idx], weight: Number(e.target.value) };
                          setBindingDraft(next);
                        }}
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        value={String(b.priority)}
                        onChange={(e) => {
                          const next = [...bindingDraft];
                          next[idx] = { ...next[idx], priority: Number(e.target.value) };
                          setBindingDraft(next);
                        }}
                      />
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {ragTopK > 0 && b.enabled ? allocMap.get(b.kb_id) ?? "-" : "-"}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          const next = bindingDraft.filter((_, i) => i !== idx);
                          setBindingDraft(next);
                        }}
                      >
                        移除
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {!bindingDraft.length ? (
                  <TableRow>
                    <TableCell className="text-sm text-muted-foreground" colSpan={7}>
                      暂无绑定，请添加 KB
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>

            <div className="mt-3 flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">添加 KB</div>
                <Select
                  className="w-[320px] max-w-full"
                  value={kbToAdd}
                  onChange={(e) => setKbToAdd(e.target.value)}
                >
                  {(kbs.data?.items || [])
                    .filter((x) => !bindingDraft.some((b) => b.kb_id === x.id))
                    .map((kb) => (
                      <option key={kb.id} value={kb.id}>
                        {kb.name} ({kb.id})
                      </option>
                    ))}
                </Select>
              </div>
              <Button
                variant="outline"
                onClick={() => {
                  const kid = (kbToAdd || "").trim();
                  if (!kid) return;
                  if (bindingDraft.some((b) => b.kb_id === kid)) return;
                  const kbName = (kbs.data?.items || []).find((x) => x.id === kid)?.name || "";
                  setBindingDraft([...bindingDraft, { kb_id: kid, kb_name: kbName, weight: 1, priority: 0, enabled: true }]);
                }}
              >
                添加
              </Button>
              <Button disabled={saveBindings.isPending} onClick={() => saveBindings.mutate()}>
                {saveBindings.isPending ? "保存中..." : "保存绑定"}
              </Button>
            </div>

            <div className="mt-3 text-xs text-muted-foreground">
              当前 RAG_TOP_K：<span className="font-mono">{ragTopK || "-"}</span>（topK 估算按 weight/priority 分配，仅用于解释）
            </div>
          </Card>

          <Card title="调试" description="服务端返回的原始数据（只读）">
            <JsonView value={{ app: app.data, bindings: bindings.data }} />
          </Card>
        </div>
      ) : null}
    </div>
  );
}
