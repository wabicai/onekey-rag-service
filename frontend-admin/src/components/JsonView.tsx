import { useMemo, useState } from "react";

import { Button } from "./ui/button";
import { cn } from "../lib/utils";

export function JsonView(props: { value: unknown; className?: string; defaultCollapsed?: boolean }) {
  const [collapsed, setCollapsed] = useState(!!props.defaultCollapsed);
  const text = useMemo(() => JSON.stringify(props.value ?? null, null, 2), [props.value]);

  return (
    <div className={cn("rounded-md border bg-muted/30", props.className)}>
      <div className="flex items-center justify-between gap-3 border-b px-3 py-2">
        <div className="text-xs text-muted-foreground">JSON</div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void navigator.clipboard?.writeText(text);
            }}
          >
            复制
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => setCollapsed((v) => !v)}>
            {collapsed ? "展开" : "收起"}
          </Button>
        </div>
      </div>
      {collapsed ? null : <pre className="overflow-x-auto p-3 font-mono text-xs leading-relaxed">{text}</pre>}
    </div>
  );
}
