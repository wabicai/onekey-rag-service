/**
 * API 模块统一导出
 *
 * 使用示例:
 * import { kbs, jobs, apps } from "@/api";
 * const data = await kbs.listKbs(workspaceId, { page: 1 });
 */

// 基础客户端
export * from "./client";

// 资源 API
export * as kbs from "./kbs";
export * as apps from "./apps";
export * as jobs from "./jobs";
export * as pages from "./pages";
export * as feedback from "./feedback";
export * as observability from "./observability";
export * as dashboard from "./dashboard";
export * as settings from "./settings";
