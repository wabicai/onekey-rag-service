import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";

import { ApiErrorBanner } from "../components/ApiErrorBanner";
import { Card } from "../components/Card";
import { ConfirmDangerDialog } from "../components/ConfirmDangerDialog";
import { EmptyState } from "../components/EmptyState";
import { KbStatsSummary } from "../components/KbStatsSummary";
import { Badge } from "../components/ui/badge";
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
import { Label } from "../components/ui/label";
import { Select } from "../components/ui/select";
import { Separator } from "../components/ui/separator";
import { FilterChips, type FilterChip } from "../components/FilterChips";
import { EntityLinksBar } from "../components/EntityLinksBar";
import { apiFetch } from "../lib/api";
import { cn } from "../lib/utils";
import { useWorkspace } from "../lib/workspace";

type KbsResp = {
  items: Array<{
    id: string;
    name: string;
    status: string;
    updated_at: string | null;
    stats?: {
      pages: { total: number; last_crawled_at: string | null };
      chunks: { total: number; with_embedding: number; embedding_coverage: number; last_indexed_at: string | null };
    };
    referenced_by?: {
      total: number;
      items: Array<{ app_id: string; name: string; public_model_id: string }>;
    };
  }>;
};

export function KbsPage() {
  const { workspaceId } = useWorkspace();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const [sp, setSp] = useSearchParams();

  // 允许从 Dashboard / 其他页面通过 ?create=1 直接打开创建向导
  // 目的：把“想新建 KB”的动作连到知识库页面，而不是让用户自己再点一次按钮。
  const createParam = (sp.get("create") || "").trim();
  const appIdFilter = (sp.get("app_id") || "").trim();

  function updateUrlFilter(nextKV: Array<[string, string | null]>) {
    const next = new URLSearchParams(sp);
    for (const [k, v] of nextKV) {
      const vv = (v || "").trim();
      if (!vv) next.delete(k);
      else next.set(k, vv);
    }
    setSp(next, { replace: true });
  }

  useEffect(() => {
    if (createParam !== "1") return;
    setCreateOpen(true);
    // 用完即清：避免刷新/返回时反复弹出
    const next = new URLSearchParams(sp);
    next.delete("create");
    setSp(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createParam]);

  const q = useQuery({
    queryKey: ["kbs", workspaceId],
    queryFn: () => apiFetch<KbsResp>(`/admin/api/workspaces/${workspaceId}/kbs`),
    enabled: !!workspaceId,
  });

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [wizardStep, setWizardStep] = useState<1 | 2 | 3>(1);
  const [sourceType, setSourceType] = useState<"file" | "crawler" | "empty">("crawler");
  const [segmentLength, setSegmentLength] = useState(800);
  const [segmentOverlap, setSegmentOverlap] = useState(120);
  const [language, setLanguage] = useState("auto");
  const [scheduleMode, setScheduleMode] = useState<"manual" | "daily" | "weekly">("manual");
  const create = useMutation({
    mutationFn: async () => {
      return apiFetch<{ id: string }>(`/admin/api/workspaces/${workspaceId}/kbs`, {
        method: "POST",
        body: JSON.stringify({
          name,
          description,
          config: {
            doc_processing: {
              chunk_size: segmentLength,
              chunk_overlap: segmentOverlap,
              language,
            },
            creation_source: sourceType,
            schedule: scheduleMode,
          },
        }),
      });
    },
    onSuccess: async (data) => {
      setName("");
      setDescription("");
      setWizardStep(1);
      setCreateOpen(false);
      await qc.invalidateQueries({ queryKey: ["kbs", workspaceId] });
      toast.success("已创建知识库，前往配置数据源");
      navigate(`/kbs/${encodeURIComponent(data.id)}`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "创建失败"),
  });

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

  const [search, setSearch] = useState("");

  const chips: FilterChip[] = [
    appIdFilter
      ? {
          key: "app_id",
          label: "应用",
          value: appIdFilter,
          onRemove: () => updateUrlFilter([["app_id", null]]),
        }
      : null,
  ].filter(Boolean) as FilterChip[];

  const filtered = useMemo(() => {
    const items = q.data?.items || [];

    const byApp = appIdFilter
      ? items.filter((it) => (it.referenced_by?.items || []).some((x) => x.app_id === appIdFilter))
      : items;

    if (!search.trim()) return byApp;
    return byApp.filter((it) => {
      const s = search.toLowerCase();
      return it.name.toLowerCase().includes(s) || it.id.toLowerCase().includes(s);
    });
  }, [q.data?.items, search, appIdFilter]);

  const stepper = (
    <div className="flex items-center gap-3 text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
      {[1, 2, 3].map((s) => (
        <div key={s} className="flex items-center gap-2">
          <div
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-full border text-sm",
              s === wizardStep ? "border-primary text-primary" : "border-border text-muted-foreground"
            )}
          >
            {s}
          </div>
          {s < 3 ? <div className="h-px w-12 bg-border" /> : null}
        </div>
      ))}
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 rounded-2xl border border-border/60 bg-gradient-to-br from-card/80 via-card/60 to-background p-6 shadow-xl shadow-black/30">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-xs tracking-wider text-primary">知识库</div>
            <div className="text-2xl font-semibold text-foreground">知识库</div>
            <div className="text-sm text-muted-foreground">
              统一管理数据源、采集与构建索引。支持文件导入与网站采集（爬虫）。
            </div>
            <EntityLinksBar appId={appIdFilter} className="mt-2" />
          </div>
          <div className="flex items-center gap-2">
            <Dialog open={createOpen} onOpenChange={(open) => (setCreateOpen(open), open || setWizardStep(1))}>
              <DialogTrigger asChild>
                <Button className="bg-primary text-primary-foreground hover:bg-primary/90">新建知识库</Button>
              </DialogTrigger>
              <DialogContent className="max-w-3xl space-y-4">
                <DialogHeader className="space-y-2">
                  <DialogTitle>新建知识库向导（3 步）</DialogTitle>
                  <DialogDescription>网站爬虫 / 空知识库（文件导入功能开发中）。</DialogDescription>
                  {stepper}
                </DialogHeader>
                {create.error ? <ApiErrorBanner error={create.error} /> : null}
                {wizardStep === 1 ? (
                  <div className="space-y-4">
                    <div className="grid grid-cols-2 gap-3">
                      {[
                        { key: "crawler", title: "网站爬虫", desc: "从站点采集页面，按规则过滤" },
                        { key: "empty", title: "空知识库", desc: "先创建，稍后再配置数据源" },
                      ].map((opt) => (
                        <button
                          key={opt.key}
                          type="button"
                          onClick={() => setSourceType(opt.key as typeof sourceType)}
                          className={cn(
                            "group rounded-xl border border-border/70 bg-card/60 p-4 text-left transition hover:border-primary/60 hover:bg-card/90",
                            sourceType === opt.key ? "border-primary/80 shadow-[0_0_0_1px_hsl(var(--primary)/0.55)]" : ""
                          )}
                        >
                          <div className="text-sm font-semibold text-foreground">{opt.title}</div>
                          <div className="text-xs text-muted-foreground">{opt.desc}</div>
                        </button>
                      ))}
                    </div>
                    <div className="rounded-xl border border-border/70 bg-muted/20 p-3 text-xs text-muted-foreground">
                      文件导入功能开发中：先使用「网站爬虫」或「空知识库」完成创建，后续再补充导入入口。
                    </div>
                    <Separator />
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">名称</Label>
                        <Input
                          placeholder="例如：OneKey Docs"
                          value={name}
                          onChange={(e) => setName(e.target.value)}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">描述（可选）</Label>
                        <Input
                          placeholder="用途、覆盖内容"
                          value={description}
                          onChange={(e) => setDescription(e.target.value)}
                        />
                      </div>
                    </div>
                  </div>
                ) : null}
                {wizardStep === 2 ? (
                  <div className="space-y-4">
                    <div className="grid grid-cols-3 gap-3">
                      <div className="space-y-1 rounded-xl border border-border/70 bg-card/60 p-3">
                        <Label className="text-xs text-muted-foreground">分段长度</Label>
                        <Input
                          type="number"
                          value={segmentLength}
                          min={200}
                          max={4000}
                          onChange={(e) => setSegmentLength(Number(e.target.value) || 0)}
                        />
                        <div className="text-[11px] text-muted-foreground">建议 500-1200。</div>
                      </div>
                      <div className="space-y-1 rounded-xl border border-border/70 bg-card/60 p-3">
                        <Label className="text-xs text-muted-foreground">重叠长度</Label>
                        <Input
                          type="number"
                          value={segmentOverlap}
                          min={0}
                          max={600}
                          onChange={(e) => setSegmentOverlap(Number(e.target.value) || 0)}
                        />
                        <div className="text-[11px] text-muted-foreground">避免断句丢信息。</div>
                      </div>
                      <div className="space-y-1 rounded-xl border border-border/70 bg-card/60 p-3">
                        <Label className="text-xs text-muted-foreground">语言/编码</Label>
                        <Select value={language} onChange={(e) => setLanguage(e.target.value)}>
                          <option value="auto">自动检测</option>
                          <option value="zh">中文</option>
                          <option value="en">英文</option>
                        </Select>
                        <div className="text-[11px] text-muted-foreground">自动时按内容自适应。</div>
                      </div>
                    </div>
                    <div className="rounded-xl border border-border/70 bg-card/60 p-3 text-xs text-muted-foreground">
                      解析与分段参数会存入知识库配置，后续在“配置”Tab 可调整。
                    </div>
                  </div>
                ) : null}
                {wizardStep === 3 ? (
                  <div className="space-y-4">
                    <div className="grid grid-cols-3 gap-3">
                      {[
                        { key: "manual", title: "手动触发", desc: "创建后在运行中心触发" },
                        { key: "daily", title: "每日调度", desc: "每天定时采集/构建索引" },
                        { key: "weekly", title: "每周调度", desc: "每周巡检更新" },
                      ].map((opt) => (
                        <button
                          key={opt.key}
                          type="button"
                          onClick={() => setScheduleMode(opt.key as typeof scheduleMode)}
                          className={cn(
                            "group rounded-xl border border-border/70 bg-card/60 p-4 text-left transition hover:border-primary/60 hover:bg-card/90",
                            scheduleMode === opt.key ? "border-primary/80 shadow-[0_0_0_1px_hsl(var(--primary)/0.55)]" : ""
                          )}
                        >
                          <div className="text-sm font-semibold text-foreground">{opt.title}</div>
                          <div className="text-xs text-muted-foreground">{opt.desc}</div>
                        </button>
                      ))}
                    </div>
                    <div className="rounded-xl border border-border/70 bg-card/60 p-4">
                      <div className="text-sm font-semibold text-foreground">确认</div>
                      <div className="mt-2 grid grid-cols-2 gap-3 text-xs text-muted-foreground">
                        <div>
                          <div className="text-[11px] uppercase tracking-[0.08em] text-primary">名称</div>
                          <div className="font-medium text-foreground">{name || "未填写"}</div>
                        </div>
                        <div>
                          <div className="text-[11px] uppercase tracking-[0.08em] text-primary">数据源</div>
                          <div className="font-medium text-foreground">
                            {sourceType === "file" ? "文件导入" : sourceType === "crawler" ? "网站爬虫" : "空知识库"}
                          </div>
                        </div>
                        <div>
                          <div className="text-[11px] uppercase tracking-[0.08em] text-primary">分段</div>
                          <div>
                            {segmentLength} / {segmentOverlap}
                          </div>
                        </div>
                        <div>
                          <div className="text-[11px] uppercase tracking-[0.08em] text-primary">调度</div>
                          <div>{scheduleMode === "manual" ? "手动" : scheduleMode === "daily" ? "每日" : "每周"}</div>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : null}
                <DialogFooter className="flex items-center justify-between">
                  <div className="text-xs text-muted-foreground">
                    网站爬虫/空知识库：可立即使用；文件导入功能开发中（计划支持 MD / PDF / DOCX / TXT / CSV / HTML）。
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" disabled={wizardStep === 1} onClick={() => setWizardStep((p) => (p === 1 ? 1 : ((p - 1) as any)))}>
                      上一步
                    </Button>
                    {wizardStep < 3 ? (
                      <Button onClick={() => setWizardStep((p) => (p === 3 ? 3 : ((p + 1) as any)))} disabled={!name.trim() && wizardStep === 1}>
                        下一步
                      </Button>
                    ) : (
                      <Button disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>
                        {create.isPending ? "创建中..." : "创建知识库"}
                      </Button>
                    )}
                  </div>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-xl border border-border/70 bg-card/70 p-4">
            <div className="text-xs text-muted-foreground">知识库总数</div>
            <div className="text-2xl font-semibold text-foreground">{q.data?.items.length || 0}</div>
          </div>
          <div className="rounded-xl border border-border/70 bg-card/70 p-4">
            <div className="text-xs text-muted-foreground">活跃状态</div>
            <div className="text-2xl font-semibold text-primary">
              {(q.data?.items || []).filter((i) => i.status === "active").length}
            </div>
          </div>
          <div className="rounded-xl border border-border/70 bg-card/70 p-4">
            <div className="text-xs text-muted-foreground">被应用引用的 KB</div>
            <div className="text-2xl font-semibold text-foreground">
              {(q.data?.items || []).filter((i) => (i.referenced_by?.total || 0) > 0).length}
            </div>
          </div>
        </div>
      </div>

      <Card
        title="知识库列表"
        description="管理知识库及其数据源，按名称或 ID 搜索。"
        actions={
          <Input
            placeholder="按名称 / ID 搜索"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-56 bg-background/50"
          />
        }
        className="border border-border/60 bg-card/80 shadow-lg shadow-black/20"
      >
        {q.isLoading ? <div className="text-sm text-muted-foreground">加载中...</div> : null}
        {q.error ? <ApiErrorBanner error={q.error} /> : null}

        {chips.length ? (
          <div className="pb-3">
            <FilterChips items={chips} />
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>当前仅展示被该应用引用的知识库。</span>
              {appIdFilter ? (
                <>
                  <span className="text-border">·</span>
                  <Link className="underline underline-offset-2" to={`/apps/${encodeURIComponent(appIdFilter)}`}>
                    应用详情
                  </Link>
                  <Link
                    className="underline underline-offset-2"
                    to={`/observability?app_id=${encodeURIComponent(appIdFilter)}`}
                    title="按 app_id 过滤观测事件"
                  >
                    观测（按应用）
                  </Link>
                  <Link className="underline underline-offset-2" to="/apps">
                    应用列表
                  </Link>
                </>
              ) : null}
              <span className="text-border">·</span>
              <Link className="underline underline-offset-2" to="/kbs" title="移除 app_id 过滤条件">
                清除筛选
              </Link>
            </div>
          </div>
        ) : null}

        {!filtered.length ? (
          <EmptyState
            description="新建知识库后，可在详情页配置数据源，并在运行中心触发采集与构建索引。"
            actions={
              <Button type="button" onClick={() => setCreateOpen(true)}>
                新建知识库
              </Button>
            }
          />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border/70">
            <table className="min-w-full text-sm">
              <thead className="bg-muted/30 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 text-left">名称 / ID</th>
                  <th className="px-4 py-2 text-left">统计</th>
                  <th className="px-4 py-2 text-left">状态</th>
                  <th className="px-4 py-2 text-left">更新时间</th>
                  <th className="px-4 py-2 text-left">操作</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((it) => (
                  <tr key={it.id} className="border-t border-border/60">
                    <td className="px-4 py-3">
                      <div className="font-semibold text-foreground">{it.name}</div>
                      <div className="font-mono text-[11px] text-muted-foreground">{it.id}</div>
                      {it.referenced_by?.items?.length ? (
                        <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                          <span>引用：</span>
                          {it.referenced_by.items
                            .slice(0, 3)
                            .map((a) => (
                              <Link
                                key={a.app_id}
                                className="rounded-md border border-border/60 bg-muted/30 px-1.5 py-0.5 hover:bg-muted/40"
                                to={`/apps/${encodeURIComponent(a.app_id)}`}
                                title={`打开应用：${a.name}（app_id=${a.app_id}）`}
                              >
                                {a.name || a.app_id}
                              </Link>
                            ))}
                          {it.referenced_by.items.length > 3 ? (
                            <span className="text-muted-foreground/70">+{it.referenced_by.items.length - 3} 更多</span>
                          ) : null}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      <KbStatsSummary
                        pages={it.stats?.pages || { total: 0, last_crawled_at: null }}
                        chunks={
                          it.stats?.chunks || {
                            total: 0,
                            with_embedding: 0,
                            embedding_coverage: 0,
                            last_indexed_at: null,
                          }
                        }
                      />
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={it.status === "active" ? "default" : "secondary"}>{it.status}</Badge>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{it.updated_at || "-"}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => navigate(`/kbs/${encodeURIComponent(it.id)}`)}
                          title="以知识库为中心：在详情页内完成数据源/内容/运行/观测等操作"
                        >
                          打开
                        </Button>

                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => navigate(`/kbs/${encodeURIComponent(it.id)}?tab=jobs`)}
                          title="直接进入：运行（采集/构建索引记录与排障）"
                        >
                          运行
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
