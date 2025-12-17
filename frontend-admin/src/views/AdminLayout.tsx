import { BarChart3, Boxes, Database, Eye, FileText, LayoutDashboard, ListChecks, LogOut, Settings, ThumbsUp } from "lucide-react";
import { useEffect } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";

import { Button } from "../components/ui/button";
import { clearToken } from "../lib/auth";
import { cn } from "../lib/utils";
import { useMe } from "../lib/useMe";

const navItems = [
  { to: "/dashboard", label: "总览", icon: LayoutDashboard },
  { to: "/apps", label: "RagApp", icon: Boxes },
  { to: "/kbs", label: "知识库", icon: Database },
  { to: "/pages", label: "Pages", icon: FileText },
  { to: "/jobs", label: "任务", icon: ListChecks },
  { to: "/feedback", label: "反馈", icon: ThumbsUp },
  { to: "/quality", label: "质量", icon: BarChart3 },
  { to: "/observability", label: "观测", icon: Eye },
  { to: "/settings", label: "设置", icon: Settings },
];

export function AdminLayout() {
  const navigate = useNavigate();
  const me = useMe();

  useEffect(() => {
    if (!me.error) return;
    const msg = me.error instanceof Error ? me.error.message : String(me.error);
    if (!msg.includes("未登录")) return;
    clearToken();
    navigate("/login", { replace: true });
  }, [me.error, navigate]);

  return (
    <div className="relative min-h-screen bg-gradient-to-b from-background to-muted/40">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(1200px_circle_at_50%_-200px,hsl(var(--primary)/0.18),transparent_55%)]" />
      <div className="relative flex min-h-screen w-full">
        <aside className="hidden w-64 shrink-0 flex-col border-r bg-background p-4 md:flex">
          <div className="mb-4 space-y-1">
            <div className="text-sm font-semibold">OneKey RAG Admin</div>
            <div className="text-xs text-muted-foreground">
              workspace: <span className="font-mono">{me.data?.workspace_id || "-"}</span>
            </div>
          </div>

          <nav className="space-y-1">
            {navItems.map((it) => {
              const Icon = it.icon;
              return (
                <NavLink
                  key={it.to}
                  to={it.to}
                  className={({ isActive }) =>
                    cn(
                      "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-muted",
                      isActive ? "bg-muted font-medium text-foreground" : "text-muted-foreground"
                    )
                  }
                >
                  <Icon className="h-4 w-4" />
                  {it.label}
                </NavLink>
              );
            })}
          </nav>

          <div className="mt-auto pt-4">
            <Button
              variant="outline"
              className="w-full justify-start"
              onClick={() => {
                clearToken();
                navigate("/login", { replace: true });
              }}
            >
              <LogOut />
              退出登录
            </Button>
          </div>
        </aside>

        <div className="flex flex-1 flex-col">
          <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b bg-background/80 px-4 backdrop-blur md:px-6">
            <div className="text-sm text-muted-foreground md:hidden">
              OneKey RAG Admin · <span className="font-mono">{me.data?.workspace_id || "-"}</span>
            </div>
            <div className="hidden md:block" />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                clearToken();
                navigate("/login", { replace: true });
              }}
            >
              <LogOut />
              退出
            </Button>
          </header>

          <main className="mx-auto w-full max-w-[1200px] flex-1 p-4 md:p-6">
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  );
}
