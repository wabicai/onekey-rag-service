import { useMemo } from "react";

import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "./ui/dialog";
import { JsonView } from "./JsonView";
import { cn } from "../lib/utils";

function getFiniteNumber(obj: Record<string, unknown> | undefined | null, key: string): number | null {
  if (!obj) return null;
  const v = obj[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function formatPercent(done: number, total: number): string {
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return "";
  const p = Math.round((done / total) * 100);
  return `(${Math.max(0, Math.min(100, p))}%)`;
}

export function ProgressPill(props: {
  type: string;
  status: string;
  progress?: Record<string, unknown> | null;
  className?: string;
}) {
  const summary = useMemo(() => {
    const p = props.progress || undefined;
    const meaningfulKeys = Object.keys(p || {}).filter((k) => k !== "_meta");

    if (!meaningfulKeys.length) {
      if (props.status === "running") return { text: "运行中", variant: "secondary" as const };
      if (props.status === "queued") return { text: "等待中", variant: "outline" as const };
      return { text: "-", variant: "outline" as const };
    }

    if (props.type === "crawl") {
      // 常见字段（后端可能还有更多，我们只展示最有解释力的）
      const discovered = getFiniteNumber(p, "discovered");
      const fetched = getFiniteNumber(p, "fetched");
      const failed = getFiniteNumber(p, "failed");

      const total = discovered ?? null;
      const done = fetched ?? null;
      const percent = total != null && done != null ? formatPercent(done, total) : "";

      const parts = [
        done != null && total != null ? `已采集 ${done}/${total}${percent}` : done != null ? `已采集 ${done}` : null,
        failed != null ? `失败 ${failed}` : null,
      ].filter(Boolean) as string[];

      return { text: parts.length ? parts.join(" · ") : "采集", variant: "secondary" as const };
    }

    if (props.type === "index") {
      const pages = getFiniteNumber(p, "pages");
      const chunks = getFiniteNumber(p, "chunks");
      // 某些任务会返回 done/total（比如分段/向量化），尽量给出“结果视角”
      const done = getFiniteNumber(p, "done");
      const total = getFiniteNumber(p, "total");
      const percent = total != null && done != null ? formatPercent(done, total) : "";

      const parts = [
        done != null && total != null ? `进度 ${done}/${total}${percent}` : null,
        pages != null ? `页面 ${pages}` : null,
        chunks != null ? `分段 ${chunks}` : null,
      ].filter(Boolean) as string[];

      return { text: parts.length ? parts.join(" · ") : "构建索引", variant: "secondary" as const };
    }

    return { text: "progress", variant: "secondary" as const };
  }, [props.progress, props.status, props.type]);

  const hasProgress = !!(props.progress && Object.keys(props.progress).length);

  return (
    <div className={cn("flex flex-wrap items-center gap-2", props.className)}>
      <Badge variant={summary.variant}>{summary.text}</Badge>
      {hasProgress ? (
        <Dialog>
          <DialogTrigger asChild>
            <Button type="button" size="sm" variant="outline">
              查看 JSON
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>任务进度（progress）</DialogTitle>
            </DialogHeader>
            <JsonView value={props.progress} defaultCollapsed={false} />
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}

