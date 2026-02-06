import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { Card } from "../components/Card";
import { JsonView } from "../components/JsonView";
import { ApiErrorBanner } from "../components/ApiErrorBanner";
import { CopyableText } from "../components/CopyableText";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { apiFetch } from "../lib/api";
import { useWorkspace } from "../lib/workspace";
import { getContractStats } from "../api/contracts";

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
type ModelTestResult = Record<string, unknown> & { ok?: boolean; latency_ms?: number; error?: string };
type ModelTestResp = { ok: boolean; kind: string; result?: ModelTestResult; results?: Record<string, ModelTestResult> };

export function SettingsPage() {
  const { workspaceId } = useWorkspace();
  const [testPrompt, setTestPrompt] = useState("ping");
  const [testResults, setTestResults] = useState<Record<string, ModelTestResult>>({});

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

  const testModels = useMutation({
    mutationFn: async (kind: string) => {
      return apiFetch<ModelTestResp>(`/admin/api/workspaces/${workspaceId}/models/test`, {
        method: "POST",
        body: JSON.stringify({ kind, prompt: testPrompt }),
      });
    },
    onSuccess: (data) => {
      if (data.kind === "all" && data.results) {
        setTestResults(data.results);
        return;
      }
      if (data.kind && data.result) {
        setTestResults((prev) => ({ ...prev, [data.kind]: data.result || {} }));
      }
    },
  });

  // 合约索引统计（只读）
  const contractStats = useQuery({
    queryKey: ["contractStats"],
    queryFn: () => getContractStats(),
  });

  const settingsData = settings.data;
  const chat = settingsData?.models?.chat;
  const emb = settingsData?.models?.embeddings;
  const rerank = settingsData?.models?.rerank;

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-border/70 bg-gradient-to-br from-card/90 via-card/70 to-background p-6 shadow-lg shadow-black/30">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-xs tracking-wider text-primary">设置</div>
            <div className="text-2xl font-semibold text-foreground">系统设置</div>
            <div className="text-sm text-muted-foreground">模型/检索/作业/监控配置，支持一键测试与健康检查。</div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="mr-2 flex items-center gap-2 text-xs text-muted-foreground">
              workspace <span className="font-mono">{workspaceId}</span>
            </div>
            <Button asChild variant="outline" size="sm">
              <Link to="/">首页</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/observability">观测</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/observability?has_error=true">观测（仅错误）</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/jobs?status=failed">失败任务</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/kbs">知识库</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/apps">应用</Link>
            </Button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="健康检查" description="来自 /admin/api/workspaces/{workspace_id}/health">
          {health.isLoading ? <div className="text-sm text-muted-foreground">加载中...</div> : null}
          {health.error ? <ApiErrorBanner error={health.error} /> : null}
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
          {settings.error ? <ApiErrorBanner error={settings.error} /> : null}
          {settingsData ? (
            <div className="space-y-4 text-sm">
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">Chat（LLM）</div>
                <Row
                  k="provider"
                  v={
                    <CopyableText
                      text={chat?.provider || "-"}
                      textClassName="font-mono text-xs text-right"
                      className="max-w-[520px] justify-end"
                      toastText="已复制 provider"
                    />
                  }
                />
                <Row
                  k="base_url"
                  v={
                    <CopyableText
                      text={chat?.base_url || "-"}
                      href={chat?.base_url || undefined}
                      textClassName="font-mono text-xs text-right"
                      className="max-w-[520px] justify-end"
                      toastText="已复制 base_url"
                    />
                  }
                />
                <Row
                  k="model"
                  v={
                    <CopyableText
                      text={chat?.model || "-"}
                      textClassName="font-mono text-xs text-right"
                      className="max-w-[520px] justify-end"
                      toastText="已复制 model"
                    />
                  }
                />
                <Row k="timeout_s" v={chat?.timeout_s ?? "-"} />
                <Row k="max_retries" v={chat?.max_retries ?? "-"} />
              </div>

              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">Embeddings</div>
                <Row
                  k="provider"
                  v={
                    <CopyableText
                      text={emb?.provider || "-"}
                      textClassName="font-mono text-xs text-right"
                      className="max-w-[520px] justify-end"
                      toastText="已复制 embeddings provider"
                    />
                  }
                />
                <Row k="dim" v={emb?.dim ?? "-"} />
                {emb?.provider === "sentence_transformers" ? (
                  <Row
                    k="model"
                    v={
                      <CopyableText
                        text={emb?.sentence_transformers_model || "-"}
                        textClassName="font-mono text-xs text-right"
                        className="max-w-[520px] justify-end"
                        toastText="已复制 embeddings model"
                      />
                    }
                  />
                ) : null}
                {emb?.provider === "ollama" ? (
                  <>
                    <Row
                      k="base_url"
                      v={
                        <CopyableText
                          text={emb?.ollama_base_url || "-"}
                          href={emb?.ollama_base_url || undefined}
                          textClassName="font-mono text-xs text-right"
                          className="max-w-[520px] justify-end"
                          toastText="已复制 embeddings base_url"
                        />
                      }
                    />
                    <Row
                      k="model"
                      v={
                        <CopyableText
                          text={emb?.ollama_embedding_model || "-"}
                          textClassName="font-mono text-xs text-right"
                          className="max-w-[520px] justify-end"
                          toastText="已复制 embeddings model"
                        />
                      }
                    />
                  </>
                ) : null}
                <Row k="cache" v={<span className="font-mono text-xs">{JSON.stringify(emb?.cache || {}, null, 0)}</span>} />
              </div>

              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">Rerank</div>
                <Row
                  k="provider"
                  v={
                    <CopyableText
                      text={rerank?.provider || "-"}
                      textClassName="font-mono text-xs text-right"
                      className="max-w-[520px] justify-end"
                      toastText="已复制 rerank provider"
                    />
                  }
                />
                <Row
                  k="model"
                  v={
                    <CopyableText
                      text={rerank?.bge_reranker_model || "-"}
                      textClassName="font-mono text-xs text-right"
                      className="max-w-[520px] justify-end"
                      toastText="已复制 rerank model"
                    />
                  }
                />
                <Row k="device" v={rerank?.device || "-"} />
                <Row k="max_candidates" v={rerank?.max_candidates ?? "-"} />
              </div>
            </div>
          ) : null}
        </Card>

        <Card title="模型连接测试" description="不会返回密钥；仅返回成功/失败与耗时（用于快速排障）">
          <div className="space-y-3 text-sm">
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">测试输入（chat/embeddings）</div>
              <Input value={testPrompt} onChange={(e) => setTestPrompt(e.target.value)} placeholder="例如 ping" />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" disabled={!workspaceId || testModels.isPending} onClick={() => testModels.mutate("all")}>
                {testModels.isPending ? "测试中..." : "测试全部"}
              </Button>
              <Button type="button" size="sm" variant="outline" disabled={!workspaceId || testModels.isPending} onClick={() => testModels.mutate("chat")}>
                测试 Chat
              </Button>
              <Button type="button" size="sm" variant="outline" disabled={!workspaceId || testModels.isPending} onClick={() => testModels.mutate("embeddings")}>
                测试 Embeddings
              </Button>
              <Button type="button" size="sm" variant="outline" disabled={!workspaceId || testModels.isPending} onClick={() => testModels.mutate("rerank")}>
                测试 Rerank
              </Button>
            </div>
            {testModels.error ? <ApiErrorBanner error={testModels.error} /> : null}

            <div className="space-y-2">
              <TestResult title="Chat" result={testResults.chat} />
              <TestResult title="Embeddings" result={testResults.embeddings} />
              <TestResult title="Rerank" result={testResults.rerank} />
            </div>
          </div>
        </Card>

        <Card
          title="合约索引统计"
          description="全局合约地址到协议的映射统计（在知识库详情页可构建索引）"
          actions={
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline" size="sm">
                <Link to="/kbs">打开知识库</Link>
              </Button>
            </div>
          }
        >
          <div className="space-y-4 text-sm">
            {contractStats.isLoading ? <div className="text-xs text-muted-foreground">加载中...</div> : null}
            {contractStats.error ? <ApiErrorBanner error={contractStats.error} /> : null}
            {contractStats.data ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between rounded-md border bg-muted/30 p-3">
                  <span className="text-muted-foreground">总合约数</span>
                  <span className="text-2xl font-mono font-semibold">{contractStats.data.total_contracts}</span>
                </div>
                <div className="rounded-md border bg-muted/30 p-3">
                  <div className="text-xs text-muted-foreground mb-2">按协议分布</div>
                  <div className="flex flex-wrap gap-1">
                    {Object.entries(contractStats.data.by_protocol || {})
                      .sort((a, b) => b[1] - a[1])
                      .map(([proto, count]) => (
                        <Badge key={proto} variant="outline" className="text-xs">
                          {proto}: {count}
                        </Badge>
                      ))}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </Card>

        <Card title="运行配置（脱敏 JSON）" description="用于排障：检索/索引/运行/观测开关">
          {settings.isLoading ? <div className="text-sm text-muted-foreground">加载中...</div> : null}
          {settings.error ? <ApiErrorBanner error={settings.error} /> : null}
          {settings.data ? <JsonView value={settings.data} defaultCollapsed /> : null}
        </Card>

        <Card title="对外 Models" description="来自 /v1/models（用于 Widget/客户端选择 model_id）" className="lg:col-span-2">
          {models.isLoading ? <div className="text-sm text-muted-foreground">加载中...</div> : null}
          {models.error ? <ApiErrorBanner error={models.error} /> : null}
          <div className="space-y-2">
            {(models.data?.data || []).map((m) => (
              <div key={m.id} className="rounded-md border bg-muted/30 p-3">
                <div className="text-sm">
                  <CopyableText text={m.id} textClassName="font-mono text-xs" toastText="已复制 model_id" prefix={<span className="text-muted-foreground">model_id</span>} />
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

function TestResult(props: { title: string; result: ModelTestResult | undefined }) {
  const r = props.result;
  const ok = typeof r?.ok === "boolean" ? r.ok : undefined;
  const latencyMs = typeof r?.latency_ms === "number" ? r.latency_ms : null;
  const model = typeof (r as any)?.model === "string" ? String((r as any).model) : "";
  const dim = typeof (r as any)?.dim === "number" ? Number((r as any).dim) : null;
  const topChunkId = typeof (r as any)?.top_chunk_id === "number" ? Number((r as any).top_chunk_id) : null;
  const preview = typeof (r as any)?.content_preview === "string" ? String((r as any).content_preview) : "";
  const err = typeof r?.error === "string" ? r.error : "";

  return (
    <div className="rounded-md border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-medium">{props.title}</div>
        {ok === true ? (
          <Badge variant="default">ok</Badge>
        ) : ok === false ? (
          <Badge variant="destructive">failed</Badge>
        ) : (
          <Badge variant="outline">未测试</Badge>
        )}
      </div>

      {latencyMs != null ? <div className="mt-1 text-xs text-muted-foreground">latency_ms：{latencyMs}</div> : null}
      {model ? <div className="mt-1 text-xs text-muted-foreground">model：{model}</div> : null}
      {dim != null ? <div className="mt-1 text-xs text-muted-foreground">dim：{dim}</div> : null}
      {topChunkId != null ? <div className="mt-1 text-xs text-muted-foreground">top_chunk_id：{topChunkId}</div> : null}
      {preview ? <div className="mt-2 whitespace-pre-wrap break-words text-xs">{preview}</div> : null}
      {err ? (
        <div className="mt-2">
          <CopyableText text={err} textClassName="font-mono text-xs text-destructive" toastText="已复制错误信息" />
        </div>
      ) : null}
    </div>
  );
}
