export function approvalIds(approvals: ReadonlyArray<{ id: number }>) {
  return approvals.map((approval) => approval.id);
}

export function toggleApprovalSelection(selectedIds: ReadonlySet<number>, approvalId: number) {
  const next = new Set(selectedIds);
  if (next.has(approvalId)) {
    next.delete(approvalId);
  } else {
    next.add(approvalId);
  }
  return next;
}

export function replaceAllSelections(approvalIds: number[], selected: boolean) {
  return selected ? new Set(approvalIds) : new Set<number>();
}

export function reconcileSelectedApprovals(selectedIds: ReadonlySet<number>, approvals: ReadonlyArray<{ id: number }>) {
  const visibleIds = new Set(approvalIds(approvals));
  return new Set([...selectedIds].filter((id) => visibleIds.has(id)));
}

export function removeDeletedApprovals<T extends { id: number }>(approvals: T[], deletedIds: number[]) {
  const deleted = new Set(deletedIds);
  return approvals.filter((approval) => !deleted.has(approval.id));
}

type BatchSignedPdfCandidate = {
  id: number;
  status: string;
  signatureStatus: string;
};

type BatchPrintCandidate = {
  id: number;
  status: string;
  signatureStatus: string;
  signedFilePath: string | null;
};

type BatchApprovalActionResult<T> = {
  items: Array<{
    approvalId: number;
    status: "completed" | "failed";
    error?: string;
    approval?: T;
  }>;
};

export function approvalIdsEligibleForBatchSignedPdf<T extends BatchSignedPdfCandidate>(
  approvals: T[],
  selectedIds: ReadonlySet<number>
) {
  return approvals
    .filter((approval) => selectedIds.has(approval.id))
    .filter((approval) => approval.status === "approved_for_print" && approval.signatureStatus !== "not_required")
    .map((approval) => approval.id);
}

export function approvalIdsEligibleForBatchPrintArchive<T extends BatchPrintCandidate>(
  approvals: T[],
  selectedIds: ReadonlySet<number>
) {
  return approvals
    .filter((approval) => selectedIds.has(approval.id))
    .filter((approval) => {
      if (approval.status !== "approved_for_print") return false;
      if (approval.signatureStatus === "not_required") return true;
      return approval.signatureStatus === "generated" && Boolean(approval.signedFilePath);
    })
    .map((approval) => approval.id);
}

export function applyBatchApprovalActionResults<T extends { id: number }>(
  approvals: T[],
  result: BatchApprovalActionResult<T>
) {
  const updates = new Map(
    result.items
      .filter((item): item is { approvalId: number; status: "completed"; approval: T } => item.status === "completed" && Boolean(item.approval))
      .map((item) => [item.approvalId, item.approval])
  );
  return approvals.map((approval) => updates.get(approval.id) ?? approval);
}

export function statusFilterFromHash(hashValue: string) {
  const query = hashValue.split("?")[1] ?? "";
  return new URLSearchParams(query).get("status") ?? "";
}

export function signatureStatusFilterFromHash(hashValue: string) {
  const query = hashValue.split("?")[1] ?? "";
  return new URLSearchParams(query).get("signatureStatus") ?? "";
}

export type LedgerFilterState = {
  status: string;
  signatureStatus: string;
  keyword: string;
};

export function normalizeSearchKeyword(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

export function shouldResetPageForLedgerFilters(current: LedgerFilterState, next: LedgerFilterState) {
  return (
    current.status !== next.status ||
    current.signatureStatus !== next.signatureStatus ||
    normalizeSearchKeyword(current.keyword) !== normalizeSearchKeyword(next.keyword)
  );
}

export function filterApprovalsByKeyword<
  T extends { projectName: string; partName: string; version: string; currentFilePath?: string | null }
>(approvals: T[], keyword: string) {
  const normalized = keyword.trim().toLocaleLowerCase();
  if (!normalized) return approvals;

  return approvals.filter((approval) =>
    [approval.projectName, approval.partName, approval.version, approval.currentFilePath ?? ""]
      .some((value) => value.toLocaleLowerCase().includes(normalized))
  );
}

export function approvalListEmptyText(hasFilters: boolean) {
  return hasFilters ? "没有符合条件的图纸" : "暂无图纸记录";
}

export function batchActionAvailabilityText(selectedCount: number, signedPdfCount: number, archiveCount: number) {
  if (selectedCount === 0) return "已选 0 张";
  return `已选 ${selectedCount} 张，可重新生成签后 PDF ${signedPdfCount} 张，可打印归档 ${archiveCount} 张`;
}
