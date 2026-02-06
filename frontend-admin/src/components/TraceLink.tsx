import { ArrowUpRight, Copy } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { cn } from "../lib/utils";
import { Button } from "./ui/button";

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function TraceLink(props: {
  text: string;
  toastText?: string;
  to?: string;
  toLabel?: string;
  /** react-router Link state，用于详情页“智能返回”保留筛选上下文 */
  linkState?: any;
  prefix?: ReactNode;
  className?: string;
  textClassName?: string;
}) {
  return (
    <div className={cn("flex min-w-0 items-center gap-2", props.className)}>
      {props.prefix ? <div className="shrink-0">{props.prefix}</div> : null}
      <span className={cn("min-w-0 flex-1 truncate", props.textClassName)} title={props.text}>
        {props.text}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        onClick={async () => {
          const ok = await copyToClipboard(props.text);
          if (ok) toast.success(props.toastText ?? "已复制");
          else toast.error("复制失败");
        }}
        aria-label="复制"
        title="复制"
      >
        <Copy className="h-4 w-4" />
      </Button>
      {props.to ? (
        <Button
          asChild
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          aria-label={props.toLabel || "联查"}
          title={props.toLabel || "联查"}
        >
          <Link to={props.to} state={props.linkState}>
            <ArrowUpRight className="h-4 w-4" />
          </Link>
        </Button>
      ) : null}
    </div>
  );
}

