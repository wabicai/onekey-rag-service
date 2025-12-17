import { getToken, clearToken } from "./auth";

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers || {});
  headers.set("content-type", headers.get("content-type") || "application/json");

  const token = getToken();
  if (token) headers.set("authorization", `Bearer ${token}`);

  const resp = await fetch(path, { ...init, headers });
  if (resp.status === 401) {
    clearToken();
    // 兜底：localStorage 变更不会触发 React 重新渲染，直接跳回登录页避免“卡在后台但一直 401”
    if (window.location.hash !== "#/login") window.location.hash = "#/login";
    throw new Error("未登录或登录已过期");
  }
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(text || `请求失败: ${resp.status}`);
  }
  return (await resp.json()) as T;
}
