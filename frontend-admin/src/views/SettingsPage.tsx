import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { Card } from "../components/Card";
import { JsonView } from "../components/JsonView";
import { apiFetch } from "../lib/api";
import { useMe } from "../lib/useMe";

type WorkspaceHealth = { status: string; dependencies: Record<string, unknown> };
type WorkspaceSettings = {
  app_env?: string;
  log_level?: string;
  models?: {
    chat?: {
      provider?: string;
      base_url?: string;
      model?: string;
      timeout_s?: number;
      max_retries?: number;
      default_temperature?: number;
      default_top_p?: number;
      default_max_tokens?: number;
      max_concurrent_requests?: number;
    };
    embeddings?: {
      provider?: string;
      sentence_transformers_model?: string;
      ollama_base_url?: string;
      ollama_embedding_model?: string;
      dim?: number;
      cache?: { size?: number; ttl_s?: number };
    };
    rerank?: {
      provider?: string;
      bge_reranker_model?: string;
      device?: string;
      batch_size?: number;
      max_candidates?: number;
      max_chars?: number;
    };
  };
  retrieval?: Record<string, unknown>;
  indexes?: Record<string, unknown>;
  jobs?: Record<string, unknown>;
  widget?: Record<string, unknown>;
  observability?: Record<string, unknown>;
  [k: string]: unknown;
};
type ModelsResp = { object: string; data: Array<{ id: string; meta?: Record<string, unknown> }> };

export function SettingsPage() {
  const me = useMe();
  const workspaceId = me.data?.workspace_id || "default";

  const health = useQuery({
    queryKey: ["health", workspaceId],
    queryFn: () => apiFetch<WorkspaceHealth>(`/admin/api/workspaces/${workspaceId}/health`),
    enabled: !!workspaceId,
  });

  const settings = useQuery({
    queryKey: ["settings", workspaceId],
    queryFn: () => apiFetch<WorkspaceSettings>(`/admin/api/workspaces/${workspaceId}/settings`),
    enabled: !!workspaceId,
  });

  const models = useQuery({
    queryKey: ["models"],
    queryFn: () => apiFetch<ModelsResp>("/v1/models"),
  });

  const settingsData = settings.data;
  const chat = settingsData?.models?.chat;
  const emb = settingsData?.models?.embeddings;
  const rerank = settingsData?.models?.rerank;

  return (
    <div className="space-y-4">
      <div className="text-lg font-semibold">设置</div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="健康检查" description="来自 /admin/api/workspaces/{workspace_id}/health">
          {health.isLoading ? <div className="text-sm text-muted-foreground">加载中...</div> : null}
          {health.error ? <div className="text-sm text-destructive">{String(health.error)}</div> : null}
          {health.data ? (
            <div className="space-y-3">
              <div className="text-sm">
                状态：<span className="font-mono">{health.data.status}</span>
              </div>
              <JsonView value={health.data.dependencies} />
            </div>
          ) : null}
        </Card>

        <Card title="上游模型配置（可读）" description="LLM / Embeddings / Rerank（已脱敏，不含密钥）">
          {settings.isLoading ? <div className="text-sm text-muted-foreground">加载中...</div> : null}
          {settings.error ? <div className="text-sm text-destructive">{String(settings.error)}</div> : null}
          {settingsData ? (
            <div className="space-y-4 text-sm">
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">Chat（LLM）</div>
                <Row k="provider" v={chat?.provider || "-"} />
                <Row k="base_url" v={<span className="font-mono text-xs">{chat?.base_url || "-"}</span>} />
                <Row k="model" v={<span className="font-mono text-xs">{chat?.model || "-"}</span>} />
                <Row k="timeout_s" v={chat?.timeout_s ?? "-"} />
                <Row k="max_retries" v={chat?.max_retries ?? "-"} />
              </div>

              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">Embeddings</div>
                <Row k="provider" v={emb?.provider || "-"} />
                <Row k="dim" v={emb?.dim ?? "-"} />
                {emb?.provider === "sentence_transformers" ? (
                  <Row k="model" v={<span className="font-mono text-xs">{emb?.sentence_transformers_model || "-"}</span>} />
                ) : null}
                {emb?.provider === "ollama" ? (
                  <>
                    <Row k="base_url" v={<span className="font-mono text-xs">{emb?.ollama_base_url || "-"}</span>} />
                    <Row k="model" v={<span className="font-mono text-xs">{emb?.ollama_embedding_model || "-"}</span>} />
                  </>
                ) : null}
                <Row k="cache" v={<span className="font-mono text-xs">{JSON.stringify(emb?.cache || {}, null, 0)}</span>} />
              </div>

              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">Rerank</div>
                <Row k="provider" v={rerank?.provider || "-"} />
                <Row k="model" v={<span className="font-mono text-xs">{rerank?.bge_reranker_model || "-"}</span>} />
                <Row k="device" v={rerank?.device || "-"} />
                <Row k="max_candidates" v={rerank?.max_candidates ?? "-"} />
              </div>
            </div>
          ) : null}
        </Card>

        <Card title="运行配置（脱敏 JSON）" description="用于排障：检索/索引/任务/观测开关">
          {settings.isLoading ? <div className="text-sm text-muted-foreground">加载中...</div> : null}
          {settings.error ? <div className="text-sm text-destructive">{String(settings.error)}</div> : null}
          {settings.data ? <JsonView value={settings.data} defaultCollapsed /> : null}
        </Card>

        <Card title="对外 Models" description="来自 /v1/models（用于 Widget/客户端选择 model_id）" className="lg:col-span-2">
          {models.isLoading ? <div className="text-sm text-muted-foreground">加载中...</div> : null}
          {models.error ? <div className="text-sm text-destructive">{String(models.error)}</div> : null}
          <div className="space-y-2">
            {(models.data?.data || []).map((m) => (
              <div key={m.id} className="rounded-md border bg-muted/30 p-3">
                <div className="text-sm">
                  model_id：<span className="font-mono">{m.id}</span>
                </div>
                {m.meta ? <JsonView value={m.meta} className="mt-2" defaultCollapsed /> : null}
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

function Row(props: { k: string; v: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="text-muted-foreground">{props.k}</div>
      <div className="text-right">{props.v}</div>
    </div>
  );
}
