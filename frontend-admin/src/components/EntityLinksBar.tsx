import { Link } from "react-router-dom";

import { cn } from "../lib/utils";

export function EntityLinksBar(props: {
  appId?: string;
  kbId?: string;
  sourceId?: string;
  className?: string;
}) {
  const appId = (props.appId || "").trim();
  const kbId = (props.kbId || "").trim();
  const sourceId = (props.sourceId || "").trim();

  if (!appId && !kbId && !sourceId) return null;

  const links: Array<{ to: string; label: string }> = [];

  // 组合条件：尽量提供“带上下文”的深链，减少页面间来回切换造成的割裂感。
  if (appId && kbId) {
    links.push({
      to: `/observability?app_id=${encodeURIComponent(appId)}&kb_id=${encodeURIComponent(kbId)}`,
      label: "观测（按 App+KB）",
    });
    links.push({
      to: `/jobs?app_id=${encodeURIComponent(appId)}&kb_id=${encodeURIComponent(kbId)}`,
      label: "运行中心（按 App+KB）",
    });
  }

  if (appId) {
    links.push({ to: "/apps", label: "应用列表" });
    links.push({ to: `/apps/${encodeURIComponent(appId)}`, label: "查看应用" });
    links.push({ to: `/kbs?app_id=${encodeURIComponent(appId)}`, label: "该应用的 KB" });
    links.push({ to: `/jobs?app_id=${encodeURIComponent(appId)}`, label: "运行中心（按 App）" });
    links.push({ to: `/observability?app_id=${encodeURIComponent(appId)}`, label: "观测（按 App）" });
  }

  if (kbId) {
    links.push({ to: `/kbs/${encodeURIComponent(kbId)}`, label: "查看 KB" });
    // 常用流：内容/运行/数据源都在 KB 详情里，避免在全局页面间跳来跳去
    links.push({ to: `/kbs/${encodeURIComponent(kbId)}?tab=pages`, label: "KB 内容" });
    links.push({ to: `/kbs/${encodeURIComponent(kbId)}?tab=jobs`, label: "KB 运行" });
    links.push({ to: `/kbs/${encodeURIComponent(kbId)}?tab=sources`, label: "KB 数据源" });
    links.push({ to: `/observability?kb_id=${encodeURIComponent(kbId)}`, label: "观测（按 KB）" });
  }

  if (kbId && sourceId) {
    links.push({
      to: `/kbs/${encodeURIComponent(kbId)}?tab=jobs&source_id=${encodeURIComponent(sourceId)}`,
      label: "该数据源的运行",
    });
    links.push({
      to: `/kbs/${encodeURIComponent(kbId)}?tab=pages&source_id=${encodeURIComponent(sourceId)}`,
      label: "该数据源的页面",
    });
  }

  // source_id 但缺少 kb_id 时（一般是从日志/任务跳转来的）：提供一个最小可用的排障入口
  if (sourceId && !kbId) {
    links.push({ to: `/jobs?source_id=${encodeURIComponent(sourceId)}`, label: "运行中心（按 Source）" });
  }

  // 去重（同 to 的只保留第一个）
  const seen = new Set<string>();
  const dedup = links.filter((x) => (seen.has(x.to) ? false : (seen.add(x.to), true)));

  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground", props.className)}>
      <div className="text-[11px] uppercase tracking-[0.14em]">快捷跳转</div>
      <div className="h-3 w-px bg-border" />
      {dedup.map((x) => (
        <Link key={x.to} className="underline underline-offset-2 hover:text-foreground" to={x.to}>
          {x.label}
        </Link>
      ))}
    </div>
  );
}
