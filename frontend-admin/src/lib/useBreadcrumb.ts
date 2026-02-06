import { useLocation } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";

import type { BreadcrumbItem } from "../components/Breadcrumb";
import { useWorkspace } from "./workspace";

// 导航项映射
const navLabels: Record<string, string> = {
  "/kbs": "知识库",
  "/apps": "应用",
  "/feedback": "反馈",
  "/observability": "观测/排障",
  "/settings": "设置",
  "/jobs": "运行中心",
};

/**
 * 根据当前路由生成面包屑
 * 规则：
 * - /kbs → [知识库]
 * - /kbs/:id → [知识库, 详情]
 * - /jobs → [运行]
 * - /jobs/:id → [运行, 详情]
 */
export function useBreadcrumb(): BreadcrumbItem[] {
  const location = useLocation();
  const path = location.pathname;
  const { workspaceId } = useWorkspace();
  const qc = useQueryClient();

  // 从 react-query 缓存中“借用”已加载的数据，用友好名称替代纯 ID。
  // 目的：让面包屑成为稳定的导航线索（尤其在 KB/Job/Page 之间跳转时）。
  function getKbLabel(kbId: string): { label: string; title?: string } {
    if (!workspaceId || !kbId) return { label: kbId || "详情" };
    const kb = qc.getQueryData<any>(["kb", workspaceId, kbId]) as any;
    const kbName = (kb && typeof kb === "object" ? (kb.name as string | undefined) : undefined) || "";

    if (kbName && kbName.trim() && kbName.trim() !== kbId) {
      return { label: kbName.trim(), title: kbId };
    }

    // 退化：尝试从 KB 列表缓存里找
    const kbs = qc.getQueryData<any>(["kbs", workspaceId]) as any;
    const listName = (kbs?.items || []).find?.((x: any) => x?.id === kbId)?.name as string | undefined;
    if (listName && listName.trim() && listName.trim() !== kbId) {
      return { label: listName.trim(), title: kbId };
    }

    return { label: kbId };
  }

  function getAppLabel(appId: string): { label: string; title?: string } {
    if (!workspaceId || !appId) return { label: appId || "详情" };
    const app = qc.getQueryData<any>(["app", workspaceId, appId]) as any;
    const appName = (app && typeof app === "object" ? (app.name as string | undefined) : undefined) || "";

    if (appName && appName.trim() && appName.trim() !== appId) {
      return { label: appName.trim(), title: appId };
    }

    const apps = qc.getQueryData<any>(["apps", workspaceId]) as any;
    const listName = (apps?.items || []).find?.((x: any) => x?.id === appId)?.name as string | undefined;
    if (listName && listName.trim() && listName.trim() !== appId) {
      return { label: listName.trim(), title: appId };
    }

    return { label: appId };
  }

  // 顶级页面
  if (navLabels[path]) {
    return [{ label: navLabels[path] }];
  }

  // 知识库详情（支持根据 ?tab= 展示更细的面包屑，减少页面割裂感）
  if (path.startsWith("/kbs/")) {
    const kbId = path.replace("/kbs/", "");
    const sp = new URLSearchParams(location.search);
    const tab = (sp.get("tab") || "").trim();

    const tabLabel: Record<string, string> = {
      overview: "总览",
      sources: "数据源",
      pages: "内容",
      jobs: "运行",
    };

    const kbLabel = getKbLabel(kbId);

    const base: BreadcrumbItem[] = [
      { label: "知识库", to: "/kbs" },
      {
        label: kbLabel.label || kbId || "详情",
        title: kbLabel.title,
        to: kbId ? `/kbs/${encodeURIComponent(kbId)}` : undefined,
      },
    ];

    if (tab && tabLabel[tab]) {
      base.push({ label: tabLabel[tab] });
    }

    return base;
  }

  // 应用详情
  if (path.startsWith("/apps/")) {
    const appId = path.replace("/apps/", "");
    const appLabel = getAppLabel(appId);
    return [
      { label: "应用", to: "/apps" },
      { label: appLabel.label || appId || "详情", title: appLabel.title },
    ];
  }

  // 运行详情
  if (path.startsWith("/jobs/")) {
    const jobId = path.replace("/jobs/", "");
    const from = (location.state as any)?.from as { kb_id?: string; source_id?: string } | undefined;
    const fromTo = from?.kb_id
      ? `/kbs/${encodeURIComponent(from.kb_id)}?tab=jobs${from?.source_id ? `&source_id=${encodeURIComponent(from.source_id)}` : ""}`
      : "/jobs";

    return [
      { label: "运行中心", to: fromTo },
      { label: jobId || "详情" },
    ];
  }

  // 观测详情
  if (path.startsWith("/observability/retrieval-events/")) {
    const eventId = path.replace("/observability/retrieval-events/", "");
    const fromSearch = ((location.state as any)?.from?.search as string | undefined) || "";
    const fromTo = fromSearch ? `/observability?${fromSearch}` : "/observability";
    return [
      { label: "观测/排障", to: fromTo },
      { label: eventId || "详情" },
    ];
  }

  return [];
}
