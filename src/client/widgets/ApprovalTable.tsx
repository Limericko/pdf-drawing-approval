import type { Key, ReactNode } from "react";
import type { Approval } from "../api.ts";
import { Button, ButtonLink } from "../ui/actions/index.tsx";
import { DataTable, StatusChip, TableFrame, type DataTableColumn, type DataTone } from "../ui/data/index.tsx";
import { signatureStatusLabel, statusLabel } from "./status.ts";
import styles from "./ApprovalTable.module.css";

export function ApprovalTable({
  approvals,
  emptyText,
  loading = false,
  selectedIds,
  onSelectionChange,
  onDelete,
  footer
}: {
  readonly approvals: readonly Approval[];
  readonly emptyText: string;
  readonly loading?: boolean;
  readonly selectedIds?: ReadonlySet<number>;
  readonly onSelectionChange?: (selectedIds: ReadonlySet<number>) => void;
  readonly onDelete?: (approval: Approval) => void;
  readonly footer?: ReactNode;
}) {
  const columns: readonly DataTableColumn<Approval>[] = [
    { id: "project", header: "项目", cell: (approval) => <span className={styles.projectName}>{approval.projectName}</span> },
    { id: "part", header: "零件", cell: (approval) => <strong>{approval.partName}</strong> },
    { id: "version", header: "版本", align: "center", cell: (approval) => <span className={styles.version}>{approval.version}</span> },
    { id: "supervisor", header: "主管", mobileHidden: true, cell: (approval) => <ApprovalStatus status={approval.supervisorStatus} /> },
    { id: "process", header: "工艺", mobileHidden: true, cell: (approval) => <ApprovalStatus status={approval.processStatus} /> },
    { id: "status", header: "总状态", cell: (approval) => <ApprovalStatus status={approval.status} /> },
    { id: "signature", header: "签审", mobileHidden: true, cell: (approval) => <ApprovalStatus status={approval.signatureStatus} signature /> },
    { id: "submittedAt", header: "提交时间", mobileHidden: true, cell: (approval) => <time className={styles.time}>{new Date(approval.submittedAt).toLocaleString()}</time> },
    { id: "actions", header: "操作", cell: (approval) => <div className={styles.actions} onClick={(event) => event.stopPropagation()}>
      <ButtonLink variant="secondary" size="sm" href={`#/approvals/${approval.id}`} aria-label={`查看图纸 ${approval.partName}`}>查看</ButtonLink>
      {onDelete ? <Button variant="danger" size="sm" onClick={() => onDelete(approval)}>删除</Button> : null}
    </div> }
  ];

  const selectionEnabled = Boolean(selectedIds && onSelectionChange);
  return <TableFrame footer={footer}>
    <DataTable ariaLabel="图纸审批列表" columns={columns} rows={approvals} getRowKey={(approval) => approval.id}
      getRowLabel={(approval) => `${approval.projectName} ${approval.partName} ${approval.version}`}
      loading={loading} emptyTitle={emptyText} emptyDescription="有新 PDF 提交或目录扫描入库后会自动显示。"
      selectedKeys={selectionEnabled ? selectedIds : undefined}
      onSelectionChange={selectionEnabled ? (keys) => onSelectionChange?.(numberKeys(keys)) : undefined}
      onRowActivate={(approval) => { location.hash = `/approvals/${approval.id}`; }} stickyHeader />
  </TableFrame>;
}

function ApprovalStatus({ status, signature = false }: { readonly status: string; readonly signature?: boolean }) {
  const presentation = approvalStatusPresentation(status, signature);
  return <StatusChip tone={presentation.tone}>{presentation.label}</StatusChip>;
}

export function approvalStatusPresentation(status: string, signature = false): { readonly label: string; readonly tone: DataTone } {
  const tone: DataTone = status === "approved" || status === "generated" || status === "printed_archived" ? "success"
    : status === "rejected" || status === "invalid_pdf" || status === "file_missing" || status === "failed" ? "danger"
      : status === "pending" || status === "placement_required" || status === "ready" || status === "filename_invalid" ? "warning"
        : status === "approved_for_print" || status === "running" ? "info" : "neutral";
  return { label: signature ? signatureStatusLabel(status) : statusLabel(status), tone };
}

function numberKeys(keys: ReadonlySet<Key>) {
  return new Set([...keys].map(Number));
}
