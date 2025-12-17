import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Textarea } from "../components/ui/textarea";
import { Card } from "../components/Card";
import { Pagination } from "../components/Pagination";
import { apiFetch } from "../lib/api";
import { useMe } from "../lib/useMe";

type KbsResp = { items: Array<{ id: string; name: string; status: string }> };
type SourcesResp = { items: Array<{ id: string; name: string; type: string; status: string; config: Record<string, unknown> }> };

type JobsResp = {
  page: number;
  page_size: number;
  total: number;
  items: Array<{
    id: string;
    type: string;
    status: string;
    kb_id: string;
    app_id: string;
    source_id: string;
    progress: Record<string, unknown>;
    error: string;
    started_at: string | null;
    finished_at: string | null;
  }>;
};

function parseLines(text: string): string[] | undefined {
  const lines = (text || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  return lines.length ? lines : undefined;
}

function formatProgress(type: string, progress: Record<string, unknown> | undefined): string {
  if (!progress) return "";
  const getNum = (k: string) => {
    const v = progress[k];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  if (type === "crawl") {
    const discovered = getNum("discovered");
    const fetched = getNum("fetched");
    const succeeded = getNum("succeeded");
    const failed = getNum("failed");
    const parts = [
      discovered != null ? `discovered=${discovered}` : "",
      fetched != null ? `fetched=${fetched}` : "",
      succeeded != null ? `ok=${succeeded}` : "",
      failed != null ? `fail=${failed}` : "",
    ].filter(Boolean);
    return parts.join(" ");
  }
  if (type === "index") {
    const pages = getNum("pages");
    const chunks = getNum("chunks");
    const embedded = getNum("embedded");
    const upserted = getNum("upserted");
    const parts = [
      pages != null ? `pages=${pages}` : "",
      chunks != null ? `chunks=${chunks}` : "",
      embedded != null ? `embedded=${embedded}` : "",
      upserted != null ? `upserted=${upserted}` : "",
    ].filter(Boolean);
    return parts.join(" ");
  }
  return "";
}

export function JobsPage() {
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

  // ======== 触发 Crawl ========
  const [crawlKbId, setCrawlKbId] = useState<string>("default");
  const [crawlSourceId, setCrawlSourceId] = useState<string>("source_default");
  const [crawlMode, setCrawlMode] = useState<string>("full");
  const [baseUrl, setBaseUrl] = useState<string>("");
  const [sitemapUrl, setSitemapUrl] = useState<string>("");
  const [seedUrls, setSeedUrls] = useState<string>("");
  const [includePatterns, setIncludePatterns] = useState<string>("");
  const [excludePatterns, setExcludePatterns] = useState<string>("");
  const [maxPages, setMaxPages] = useState<string>("");

  const sources = useQuery({
    queryKey: ["sources", workspaceId, crawlKbId],
    queryFn: () => apiFetch<SourcesResp>(`/admin/api/workspaces/${workspaceId}/kbs/${crawlKbId}/sources`),
    enabled: !!workspaceId && !!crawlKbId,
  });

  useEffect(() => {
    const firstKb = kbs.data?.items?.[0];
    if (!firstKb) return;
    if (crawlKbId) return;
    setCrawlKbId(firstKb.id);
  }, [kbs.data, crawlKbId]);

  useEffect(() => {
    const first = sources.data?.items?.[0];
    if (!first) return;
    if (sources.data?.items?.some((s) => s.id === crawlSourceId)) return;
    setCrawlSourceId(first.id);
  }, [sources.data, crawlSourceId]);

  const triggerCrawl = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {
        kb_id: crawlKbId,
        source_id: crawlSourceId,
        mode: crawlMode,
      };
      if (baseUrl.trim()) payload.base_url = baseUrl.trim();
      if (sitemapUrl.trim()) payload.sitemap_url = sitemapUrl.trim();
      const seed = parseLines(seedUrls);
      const inc = parseLines(includePatterns);
      const exc = parseLines(excludePatterns);
      if (seed) payload.seed_urls = seed;
      if (inc) payload.include_patterns = inc;
      if (exc) payload.exclude_patterns = exc;
      if (maxPages.trim()) payload.max_pages = Number(maxPages.trim());

      return apiFetch<{ job_id: string }>(`/admin/api/workspaces/${workspaceId}/jobs/crawl`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
    },
    onSuccess: async (data) => {
      await qc.invalidateQueries({ queryKey: ["jobs", workspaceId] });
      navigate(`/jobs/${data.job_id}`);
    },
  });

  // ======== 触发 Index ========
  const [indexKbId, setIndexKbId] = useState<string>("default");
  const [indexMode, setIndexMode] = useState<string>("incremental");

  useEffect(() => {
    const firstKb = kbs.data?.items?.[0];
    if (!firstKb) return;
    if (indexKbId) return;
    setIndexKbId(firstKb.id);
  }, [kbs.data, indexKbId]);

  const triggerIndex = useMutation({
    mutationFn: async () => {
      return apiFetch<{ job_id: string }>(`/admin/api/workspaces/${workspaceId}/jobs/index`, {
        method: "POST",
        body: JSON.stringify({ kb_id: indexKbId, mode: indexMode }),
      });
    },
    onSuccess: async (data) => {
      await qc.invalidateQueries({ queryKey: ["jobs", workspaceId] });
      navigate(`/jobs/${data.job_id}`);
    },
  });

  // ======== Job 列表 ========
  const [page, setPage] = useState<number>(1);
  const [pageSize] = useState<number>(20);
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [kbFilter, setKbFilter] = useState<string>("");
  const [appFilter, setAppFilter] = useState<string>("");
  const [sourceFilter, setSourceFilter] = useState<string>("");
  const [qFilter, setQFilter] = useState<string>("");
  const [createdFrom, setCreatedFrom] = useState<string>("");
  const [createdTo, setCreatedTo] = useState<string>("");

  useEffect(() => {
    const qKb = (sp.get("kb_id") || "").trim();
    if (!qKb) return;
    setCrawlKbId(qKb);
    setIndexKbId(qKb);
    setKbFilter(qKb);
    setPage(1);
  }, [sp]);

  const jobsQuery = useQuery({
    queryKey: ["jobs", workspaceId, page, pageSize, typeFilter, statusFilter, kbFilter, appFilter, sourceFilter, qFilter, createdFrom, createdTo],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("page_size", String(pageSize));
      if (typeFilter) params.set("type", typeFilter);
      if (statusFilter) params.set("status", statusFilter);
      if (kbFilter) params.set("kb_id", kbFilter);
      if (appFilter.trim()) params.set("app_id", appFilter.trim());
      if (sourceFilter.trim()) params.set("source_id", sourceFilter.trim());
      if (qFilter.trim()) params.set("q", qFilter.trim());
      if (createdFrom.trim()) params.set("created_from", createdFrom.trim());
      if (createdTo.trim()) params.set("created_to", createdTo.trim());
      return apiFetch<JobsResp>(`/admin/api/workspaces/${workspaceId}/jobs?${params.toString()}`);
    },
    enabled: !!workspaceId,
  });

  const requeue = useMutation({
    mutationFn: async (jobId: string) => {
      return apiFetch<{ ok: boolean }>(`/admin/api/workspaces/${workspaceId}/jobs/${jobId}/requeue`, { method: "POST" });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["jobs", workspaceId] });
    },
  });

  const cancel = useMutation({
    mutationFn: async (jobId: string) => {
      return apiFetch<{ ok: boolean }>(`/admin/api/workspaces/${workspaceId}/jobs/${jobId}/cancel`, { method: "POST" });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["jobs", workspaceId] });
    },
  });

  const actionError = useMemo(() => {
    const err = triggerCrawl.error || triggerIndex.error || requeue.error || cancel.error;
    if (!err) return "";
    return err instanceof Error ? err.message : String(err);
  }, [triggerCrawl.error, triggerIndex.error, requeue.error, cancel.error]);

  return (
    <div className="space-y-4">
      <div className="text-lg font-semibold">任务中心</div>

      {actionError ? <div className="text-sm text-destructive">{actionError}</div> : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card
          title="触发抓取（crawl）"
          description="sitemap 优先，失败自动降级为 seed_urls；可用输入覆盖 DataSource.config"
          actions={
            <Button variant="outline" size="sm" onClick={() => navigate("/kbs")} title="去管理数据源">
              管理 KB/Source
            </Button>
          }
        >
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">KB</div>
                <Select
                  value={crawlKbId}
                  onChange={(e) => setCrawlKbId(e.target.value)}
                >
                  {(kbs.data?.items || []).map((kb) => (
                    <option key={kb.id} value={kb.id}>
                      {kb.name} ({kb.id})
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">Source</div>
                <Select
                  value={crawlSourceId}
                  onChange={(e) => setCrawlSourceId(e.target.value)}
                >
                  {(sources.data?.items || []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.id})
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">Mode</div>
                <Select
                  value={crawlMode}
                  onChange={(e) => setCrawlMode(e.target.value)}
                >
                  <option value="full">full</option>
                  <option value="incremental">incremental</option>
                </Select>
              </div>
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">max_pages（可选）</div>
                <Input placeholder="例如 5000" value={maxPages} onChange={(e) => setMaxPages(e.target.value)} />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">base_url（可选）</div>
                <Input placeholder="例如 https://developer.onekey.so/" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
              </div>
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">sitemap_url（可选）</div>
                <Input placeholder="例如 https://.../sitemap.xml" value={sitemapUrl} onChange={(e) => setSitemapUrl(e.target.value)} />
              </div>
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">seed_urls（可选，每行一个）</div>
                <Textarea value={seedUrls} onChange={(e) => setSeedUrls(e.target.value)} placeholder="https://example.com/\nhttps://example.com/docs/" />
              </div>
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">include_patterns / exclude_patterns（可选，每行一个正则）</div>
                <div className="grid grid-cols-1 gap-2">
                  <Textarea value={includePatterns} onChange={(e) => setIncludePatterns(e.target.value)} placeholder="^https://example\\.com/.*$" />
                  <Textarea value={excludePatterns} onChange={(e) => setExcludePatterns(e.target.value)} placeholder="^https://example\\.com/404.*$" />
                </div>
              </div>
            </div>

            <div>
              <Button
                disabled={
                  triggerCrawl.isPending || !crawlKbId || !crawlSourceId || (maxPages.trim() ? Number.isNaN(Number(maxPages.trim())) : false)
                }
                onClick={() => triggerCrawl.mutate()}
              >
                {triggerCrawl.isPending ? "触发中..." : "触发抓取"}
              </Button>
            </div>
          </div>
        </Card>

        <Card title="触发建索引（index）" description="对已抓取页面执行 chunk + embedding 写入 chunks">
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">KB</div>
                <Select
                  value={indexKbId}
                  onChange={(e) => setIndexKbId(e.target.value)}
                >
                  {(kbs.data?.items || []).map((kb) => (
                    <option key={kb.id} value={kb.id}>
                      {kb.name} ({kb.id})
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">Mode</div>
                <Select
                  value={indexMode}
                  onChange={(e) => setIndexMode(e.target.value)}
                >
                  <option value="incremental">incremental</option>
                  <option value="full">full</option>
                </Select>
              </div>
            </div>

            <div>
              <Button disabled={triggerIndex.isPending || !indexKbId} onClick={() => triggerIndex.mutate()}>
                {triggerIndex.isPending ? "触发中..." : "触发建索引"}
              </Button>
            </div>
          </div>
        </Card>
      </div>

      <Card title="任务列表" description="支持按 type/status/KB 过滤；点击 ID 查看详情">
        <div className="grid grid-cols-1 gap-3 pb-3 md:grid-cols-2 lg:grid-cols-6">
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">type</div>
            <Select
              value={typeFilter}
              onChange={(e) => {
                setPage(1);
                setTypeFilter(e.target.value);
              }}
            >
              <option value="">全部</option>
              <option value="crawl">crawl</option>
              <option value="index">index</option>
            </Select>
          </div>
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">status</div>
            <Select
              value={statusFilter}
              onChange={(e) => {
                setPage(1);
                setStatusFilter(e.target.value);
              }}
            >
              <option value="">全部</option>
              <option value="queued">queued</option>
              <option value="running">running</option>
              <option value="succeeded">succeeded</option>
              <option value="failed">failed</option>
              <option value="cancelled">cancelled</option>
            </Select>
          </div>
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">KB</div>
            <Select
              value={kbFilter}
              onChange={(e) => {
                setPage(1);
                setKbFilter(e.target.value);
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
            <div className="text-xs text-muted-foreground">app_id</div>
            <Input
              value={appFilter}
              onChange={(e) => {
                setPage(1);
                setAppFilter(e.target.value);
              }}
              placeholder="例如 app_default"
            />
          </div>
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">source_id</div>
            <Input
              value={sourceFilter}
              onChange={(e) => {
                setPage(1);
                setSourceFilter(e.target.value);
              }}
              placeholder="例如 src_xxx"
            />
          </div>
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">q（ID/错误模糊匹配）</div>
            <Input
              value={qFilter}
              onChange={(e) => {
                setPage(1);
                setQFilter(e.target.value);
              }}
              placeholder="例如 failed / crawl_"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 pb-3 md:grid-cols-2 lg:grid-cols-6">
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">created_from</div>
            <Input
              type="date"
              value={createdFrom}
              onChange={(e) => {
                setPage(1);
                setCreatedFrom(e.target.value);
              }}
            />
          </div>
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">created_to</div>
            <Input
              type="date"
              value={createdTo}
              onChange={(e) => {
                setPage(1);
                setCreatedTo(e.target.value);
              }}
            />
          </div>
          <div className="flex items-end gap-2 lg:col-span-4">
            <Button variant="outline" onClick={() => jobsQuery.refetch()}>
              刷新
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setPage(1);
                setTypeFilter("");
                setStatusFilter("");
                setKbFilter("");
                setAppFilter("");
                setSourceFilter("");
                setQFilter("");
                setCreatedFrom("");
                setCreatedTo("");
              }}
            >
              清空
            </Button>
          </div>
        </div>

        {jobsQuery.isLoading ? <div className="text-sm text-muted-foreground">加载中...</div> : null}
        {jobsQuery.error ? <div className="text-sm text-destructive">{String(jobsQuery.error)}</div> : null}

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[180px]">ID</TableHead>
              <TableHead className="w-[90px]">类型</TableHead>
              <TableHead className="w-[120px]">状态</TableHead>
              <TableHead className="w-[160px]">KB</TableHead>
              <TableHead className="w-[160px]">App</TableHead>
              <TableHead className="w-[180px]">Source</TableHead>
              <TableHead>进度</TableHead>
              <TableHead className="w-[170px]">开始</TableHead>
              <TableHead className="w-[170px]">结束</TableHead>
              <TableHead className="w-[260px]">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(jobsQuery.data?.items || []).map((it) => (
              <TableRow key={it.id}>
                <TableCell className="font-mono text-xs">
                  <Link className="underline underline-offset-2" to={`/jobs/${it.id}`}>
                    {it.id}
                  </Link>
                </TableCell>
                <TableCell>{it.type}</TableCell>
                <TableCell>
                  <span className={it.status === "failed" ? "text-red-300" : it.status === "succeeded" ? "text-emerald-300" : ""}>
                    {it.status}
                  </span>
                  {it.error ? <span className="ml-2 text-xs text-destructive">有错误</span> : null}
                </TableCell>
                <TableCell className="font-mono text-xs">{it.kb_id || "-"}</TableCell>
                <TableCell className="font-mono text-xs">{it.app_id || "-"}</TableCell>
                <TableCell className="font-mono text-xs">{it.source_id || "-"}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{formatProgress(it.type, it.progress)}</TableCell>
                <TableCell className="text-muted-foreground">{it.started_at || "-"}</TableCell>
                <TableCell className="text-muted-foreground">{it.finished_at || "-"}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => navigate(`/jobs/${it.id}`)}>
                      详情
                    </Button>
                    <Button variant="outline" size="sm" disabled={requeue.isPending} onClick={() => requeue.mutate(it.id)}>
                      重新入队
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={cancel.isPending || it.status !== "queued"}
                      onClick={() => cancel.mutate(it.id)}
                    >
                      取消
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        <Pagination
          page={jobsQuery.data?.page || page}
          pageSize={jobsQuery.data?.page_size || pageSize}
          total={jobsQuery.data?.total || 0}
          onPageChange={(p) => setPage(p)}
        />
      </Card>
    </div>
  );
}
