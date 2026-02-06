import { cn } from "../lib/utils";

export function KbStatsSummary(props: {
  pages: { total: number; last_crawled_at: string | null };
  chunks: { total: number; with_embedding: number; embedding_coverage: number; last_indexed_at: string | null };
  className?: string;
}) {
  const pagesTotal = Number(props.pages?.total || 0);
  const chunksTotal = Number(props.chunks?.total || 0);
  const withEmbedding = Number(props.chunks?.with_embedding || 0);
  const coverage = Math.round((Number(props.chunks?.embedding_coverage || 0) || 0) * 100);
  const lastCrawled = props.pages?.last_crawled_at || "-";
  const lastIndexed = props.chunks?.last_indexed_at || "-";

  if (!pagesTotal && !chunksTotal) {
    return <div className={cn("text-xs text-muted-foreground", props.className)}>未采集/未索引</div>;
  }

  return (
    <div className={cn("space-y-1 text-xs", props.className)}>
      <div className="text-muted-foreground">
        内容页 <span className="font-mono text-foreground">{pagesTotal}</span>
        <span className="mx-2 text-border">·</span>
        分段 <span className="font-mono text-foreground">{chunksTotal}</span>
        <span className="mx-2 text-border">·</span>
        向量覆盖 <span className="font-mono text-foreground">{coverage}%</span>
      </div>

      <div className="text-muted-foreground">
        最近采集 <span className="font-mono text-foreground">{lastCrawled}</span>
      </div>

      <div className="text-muted-foreground">
        最近构建索引 <span className="font-mono text-foreground">{lastIndexed}</span>
        <span className="mx-2 text-border">·</span>
        已向量化 <span className="font-mono text-foreground">{withEmbedding}</span>
      </div>
    </div>
  );
}

