import type { ReactNode } from "react";

import { cn } from "../lib/utils";
import { Card as UiCard, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";

export function Card(props: {
  title: string;
  description?: string;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <UiCard className={cn(props.className)}>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-base">{props.title}</CardTitle>
          {props.description ? <CardDescription>{props.description}</CardDescription> : null}
        </div>
        {props.actions ? <div className="shrink-0">{props.actions}</div> : null}
      </CardHeader>
      <CardContent className="space-y-2">{props.children}</CardContent>
    </UiCard>
  );
}
