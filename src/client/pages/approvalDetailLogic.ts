import type { Approval, ApprovalAnnotation, ApprovalAnnotationKind, OperationLog, User } from "../api.ts";

export const timelinePreviewLimit = 5;

export function canEditSignaturePlacements(user: Pick<User, "role">, approval: Pick<Approval, "status">) {
  if (approval.status === "printed_archived" || approval.status === "voided") return false;
  return user.role === "admin" || user.role === "designer";
}

export function canShowSignaturePlacementPanel(
  user: Pick<User, "role">,
  approval: Pick<Approval, "status" | "signatureStatus">
) {
  return approval.signatureStatus === "placement_required" || canEditSignaturePlacements(user, approval);
}

export function canRegenerateSignedPdf(
  user: Pick<User, "role">,
  approval: Pick<Approval, "status" | "signatureStatus">
) {
  if (approval.status !== "approved_for_print") return false;
  if (approval.signatureStatus === "not_required") return false;
  return user.role === "admin" || user.role === "designer";
}

export function canSaveSignatureTemplate(user: Pick<User, "role">) {
  return user.role === "admin" || user.role === "designer";
}

export function canCreateAnnotation(user: Pick<User, "role">, approval: Pick<Approval, "status">) {
  if (isAnnotationReadonlyApproval(approval)) return false;
  return user.role === "admin" || user.role === "supervisor" || user.role === "process";
}

export function canEditAnnotation(
  user: Pick<User, "id" | "role">,
  approval: Pick<Approval, "status">,
  annotation: Pick<ApprovalAnnotation, "authorUserId" | "resolved">
) {
  if (isAnnotationReadonlyApproval(approval) || annotation.resolved) return false;
  return user.role === "admin" || annotation.authorUserId === user.id;
}

export function canResolveAnnotation(
  user: Pick<User, "id" | "role">,
  approval: Pick<Approval, "status">,
  annotation: Pick<ApprovalAnnotation, "authorUserId" | "resolved">
) {
  if (isAnnotationReadonlyApproval(approval) || annotation.resolved) return false;
  return user.role === "admin" || user.role === "designer" || annotation.authorUserId === user.id;
}

export function canShowAnnotations(_approval: Pick<Approval, "status">) {
  return true;
}

export function signaturePlacementSaveMessage(approval: Pick<Approval, "signatureStatus">) {
  return approval.signatureStatus === "generated" ? "签名位置已保存，签后 PDF 已生成。" : "签名位置已保存。";
}

export function visibleOperationLogs(logs: OperationLog[], expanded: boolean) {
  return expanded ? logs : logs.slice(-timelinePreviewLimit);
}

export type AnnotationFilterState = {
  status: "all" | "open" | "resolved";
  author: "all" | "mine";
  kind: "all" | ApprovalAnnotationKind;
  currentUserId: number;
};

export function filterAnnotations(annotations: ApprovalAnnotation[], filters: AnnotationFilterState) {
  return annotations.filter((annotation) => {
    if (filters.status === "open" && annotation.resolved) return false;
    if (filters.status === "resolved" && !annotation.resolved) return false;
    if (filters.author === "mine" && annotation.authorUserId !== filters.currentUserId) return false;
    if (filters.kind !== "all" && annotation.kind !== filters.kind) return false;
    return true;
  });
}

export function relatedVersionsForPanel(approval: Pick<Approval, "history" | "relatedVersions">) {
  return approval.relatedVersions ?? approval.history ?? [];
}

export function shouldRefreshPdfState(
  previous: Pick<Approval, "status" | "signatureStatus" | "currentFilePath" | "signedFilePath" | "signedAt" | "archivedAt"> | null,
  next: Pick<Approval, "status" | "signatureStatus" | "currentFilePath" | "signedFilePath" | "signedAt" | "archivedAt">
) {
  if (!previous) return true;
  return (
    previous.status !== next.status ||
    previous.signatureStatus !== next.signatureStatus ||
    previous.currentFilePath !== next.currentFilePath ||
    previous.signedFilePath !== next.signedFilePath ||
    previous.signedAt !== next.signedAt ||
    previous.archivedAt !== next.archivedAt
  );
}

export function detailReloadErrorMessage(error: unknown) {
  return error instanceof Error && error.message ? error.message : "图纸详情加载失败，请刷新重试。";
}

function isAnnotationReadonlyApproval(approval: Pick<Approval, "status">) {
  return approval.status === "printed_archived" || approval.status === "voided";
}
