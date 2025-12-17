import { Button } from "./ui/button";

export function Pagination(props: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
}) {
  const page = Math.max(1, props.page || 1);
  const pageSize = Math.max(1, props.pageSize || 20);
  const totalPages = Math.max(1, Math.ceil((props.total || 0) / pageSize));

  return (
    <div className="flex items-center justify-between gap-4 py-2 text-sm text-muted-foreground">
      <div>
        共 <span className="font-mono">{props.total}</span> 条，页码{" "}
        <span className="font-mono">
          {page}/{totalPages}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => props.onPageChange(page - 1)}>
          上一页
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= totalPages}
          onClick={() => props.onPageChange(page + 1)}
        >
          下一页
        </Button>
      </div>
    </div>
  );
}
