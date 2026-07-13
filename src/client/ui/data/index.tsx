import { ChevronLeft, ChevronRight, FileText, X } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  type AnchorHTMLAttributes,
  type HTMLAttributes,
  type Key,
  type ReactNode
} from "react";
import { Button, IconButton } from "../actions/index.tsx";
import { EmptyState, ErrorState, Skeleton } from "../feedback/index.tsx";
import styles from "./Data.module.css";

export type DataTone = "neutral" | "primary" | "info" | "success" | "warning" | "danger";

export function StatusChip({ tone = "neutral", className, children, ...props }:
  HTMLAttributes<HTMLSpanElement> & { readonly tone?: DataTone }) {
  return <span {...props} data-tone={tone} className={join(styles.statusChip, className)}>{children}</span>;
}

export function Badge({ tone = "neutral", className, children, ...props }:
  HTMLAttributes<HTMLSpanElement> & { readonly tone?: DataTone }) {
  return <span {...props} data-tone={tone} className={join(styles.badge, className)}>{children}</span>;
}

export type KeyValueItem = {
  readonly label: ReactNode;
  readonly value: ReactNode;
  readonly id?: string;
  readonly wide?: boolean;
};

export function KeyValueList({ items, className, ...props }:
  HTMLAttributes<HTMLDListElement> & { readonly items: readonly KeyValueItem[] }) {
  return <dl {...props} className={join(styles.keyValueList, className)}>
    {items.map((item, index) => <div key={item.id ?? index} data-wide={item.wide || undefined}>
      <dt>{item.label}</dt><dd>{item.value}</dd>
    </div>)}
  </dl>;
}

export function TableFrame({ title, description, actions, footer, className, children, ...props }:
  HTMLAttributes<HTMLElement> & {
    readonly title?: ReactNode;
    readonly description?: ReactNode;
    readonly actions?: ReactNode;
    readonly footer?: ReactNode;
  }) {
  return <section {...props} className={join(styles.tableFrame, className)}>
    {title || description || actions ? <header className={styles.tableFrameHeader}>
      <div>{title ? <h2>{title}</h2> : null}{description ? <p>{description}</p> : null}</div>
      {actions ? <div className={styles.tableFrameActions}>{actions}</div> : null}
    </header> : null}
    <div className={styles.tableViewport}>{children}</div>
    {footer ? <footer className={styles.tableFrameFooter}>{footer}</footer> : null}
  </section>;
}

export type DataTableColumn<Row> = {
  readonly id: string;
  readonly header: ReactNode;
  readonly cell: (row: Row) => ReactNode;
  readonly align?: "start" | "center" | "end";
  readonly mobileHidden?: boolean;
  readonly className?: string;
};

export type DataTableProps<Row> = {
  readonly ariaLabel: string;
  readonly columns: readonly DataTableColumn<Row>[];
  readonly rows: readonly Row[];
  readonly getRowKey: (row: Row) => Key;
  readonly getRowLabel?: (row: Row) => string;
  readonly selectedKeys?: ReadonlySet<Key>;
  readonly onSelectionChange?: (keys: ReadonlySet<Key>) => void;
  readonly isRowSelectable?: (row: Row) => boolean;
  readonly loading?: boolean;
  readonly error?: ReactNode;
  readonly onRetry?: () => void;
  readonly emptyTitle?: string;
  readonly emptyDescription?: ReactNode;
  readonly stickyHeader?: boolean;
  readonly rowClassName?: (row: Row) => string | undefined;
  readonly onRowActivate?: (row: Row) => void;
};

export function DataTable<Row>({
  ariaLabel,
  columns,
  rows,
  getRowKey,
  getRowLabel = (row) => String(getRowKey(row)),
  selectedKeys = new Set<Key>(),
  onSelectionChange,
  isRowSelectable = () => true,
  loading = false,
  error,
  onRetry,
  emptyTitle = "暂无数据",
  emptyDescription,
  stickyHeader = false,
  rowClassName,
  onRowActivate
}: DataTableProps<Row>) {
  const selectableRows = onSelectionChange ? rows.filter(isRowSelectable) : [];
  const selectableKeys = selectableRows.map(getRowKey);
  const allSelected = selectableKeys.length > 0 && selectableKeys.every((key) => selectedKeys.has(key));
  const partiallySelected = !allSelected && selectableKeys.some((key) => selectedKeys.has(key));
  const selectAllRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = partiallySelected;
  }, [partiallySelected]);

  if (loading) return <div className={styles.tableState} aria-busy="true">
    <Skeleton lines={4} label={`正在加载${ariaLabel}`} />
  </div>;
  if (error) return <div className={styles.tableState}><ErrorState title="数据加载失败" onRetry={onRetry}>{error}</ErrorState></div>;
  if (rows.length === 0) return <div className={styles.tableState}><EmptyState title={emptyTitle}>{emptyDescription}</EmptyState></div>;

  function toggleAll() {
    if (!onSelectionChange) return;
    const next = new Set(selectedKeys);
    if (allSelected) selectableKeys.forEach((key) => next.delete(key));
    else selectableKeys.forEach((key) => next.add(key));
    onSelectionChange(next);
  }

  function toggleRow(row: Row) {
    if (!onSelectionChange) return;
    const key = getRowKey(row);
    const next = new Set(selectedKeys);
    if (next.has(key)) next.delete(key); else next.add(key);
    onSelectionChange(next);
  }

  return <table aria-label={ariaLabel} data-sticky-header={stickyHeader || undefined} className={styles.dataTable}>
    <thead><tr>
      {onSelectionChange ? <th scope="col" className={styles.selectionCell}>
        <input ref={selectAllRef} type="checkbox" checked={allSelected} onChange={toggleAll}
          aria-label={`选择全部${ariaLabel}`} />
      </th> : null}
      {columns.map((column) => <th key={column.id} scope="col" data-align={column.align}
        data-mobile-hidden={column.mobileHidden || undefined} className={column.className}>{column.header}</th>)}
    </tr></thead>
    <tbody>{rows.map((row) => {
      const key = getRowKey(row);
      const selectable = Boolean(onSelectionChange && isRowSelectable(row));
      const selected = selectedKeys.has(key);
      return <tr key={key} data-selected={selected || undefined} data-interactive={onRowActivate ? true : undefined}
        tabIndex={onRowActivate ? 0 : undefined} onClick={onRowActivate ? () => onRowActivate(row) : undefined}
        onKeyDown={onRowActivate ? (event) => {
          if (event.key === "Enter") onRowActivate(row);
        } : undefined} className={rowClassName?.(row)}>
        {onSelectionChange ? <td className={styles.selectionCell} data-label="选择">
          <input type="checkbox" checked={selected} disabled={!selectable} onChange={() => toggleRow(row)}
            onClick={(event) => event.stopPropagation()}
            aria-label={`选择 ${getRowLabel(row)}`} />
        </td> : null}
        {columns.map((column) => <td key={column.id} data-label={asText(column.header)} data-align={column.align}
          data-mobile-hidden={column.mobileHidden || undefined} className={column.className}>{column.cell(row)}</td>)}
      </tr>;
    })}</tbody>
  </table>;
}

export function Pagination({ page, pageCount, onPageChange, totalItems, disabled = false, label = "分页" }: {
  readonly page: number;
  readonly pageCount: number;
  readonly onPageChange: (page: number) => void;
  readonly totalItems?: number;
  readonly disabled?: boolean;
  readonly label?: string;
}) {
  const safeCount = Math.max(1, pageCount);
  const safePage = Math.min(Math.max(1, page), safeCount);
  return <nav className={styles.pagination} aria-label={label}>
    <span>{typeof totalItems === "number" ? `${totalItems} 条记录` : null}</span>
    <div>
      <IconButton label="上一页" variant="secondary" size="sm" disabled={disabled || safePage <= 1}
        onClick={() => onPageChange(safePage - 1)}><ChevronLeft aria-hidden="true" size={16} /></IconButton>
      <span aria-current="page">第 {safePage} / {safeCount} 页</span>
      <IconButton label="下一页" variant="secondary" size="sm" disabled={disabled || safePage >= safeCount}
        onClick={() => onPageChange(safePage + 1)}><ChevronRight aria-hidden="true" size={16} /></IconButton>
    </div>
  </nav>;
}

export type TimelineItem = {
  readonly id: Key;
  readonly title: ReactNode;
  readonly timestamp?: ReactNode;
  readonly description?: ReactNode;
  readonly tone?: DataTone;
};

export function Timeline({ items, label = "时间线", className }: {
  readonly items: readonly TimelineItem[];
  readonly label?: string;
  readonly className?: string;
}) {
  return <ol className={join(styles.timeline, className)} aria-label={label}>
    {items.map((item) => <li key={item.id} data-tone={item.tone ?? "neutral"}>
      <span className={styles.timelineMarker} aria-hidden="true" />
      <div><div className={styles.timelineHeading}><strong>{item.title}</strong>
        {item.timestamp ? <time>{item.timestamp}</time> : null}</div>
        {item.description ? <div className={styles.timelineDescription}>{item.description}</div> : null}</div>
    </li>)}
  </ol>;
}

export function FileLink({ children, className, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  return <a {...props} className={join(styles.fileLink, className)}><FileText aria-hidden="true" size={16} />
    <span>{children}</span></a>;
}

export function HashValue({ value, compact = false, className, ...props }:
  HTMLAttributes<HTMLElement> & { readonly value: string; readonly compact?: boolean }) {
  const display = compact && value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
  return <code {...props} title={props.title ?? value} className={join(styles.hashValue, className)}>{display}</code>;
}

export function BatchActionBar({ selectedCount, onClearSelection, children, label = "批量操作" }: {
  readonly selectedCount: number;
  readonly onClearSelection: () => void;
  readonly children: ReactNode;
  readonly label?: string;
}) {
  const statusId = useId();
  return <section className={styles.batchActionBar} aria-label={label} aria-describedby={statusId}>
    <strong id={statusId}>已选择 {selectedCount} 项</strong>
    <div className={styles.batchActions}>{children}</div>
    <Button variant="ghost" size="sm" onClick={onClearSelection}><X aria-hidden="true" size={15} />清除选择</Button>
  </section>;
}

function asText(value: ReactNode) {
  return typeof value === "string" || typeof value === "number" ? String(value) : "字段";
}

function join(...values: readonly (string | undefined)[]) {
  return values.filter(Boolean).join(" ");
}
