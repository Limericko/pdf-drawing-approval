// The legacy PDF widgets use numeric marker ids. Platform UUIDs are retained in
// externalId fields by the adapter so both runtimes can share the same canvas.
export type ApprovalAnnotationId = number;
export type ApprovalAnnotationKind = "pin" | "rect" | "arrow" | "circle" | "text" | "ink" | "cloud";
export type ApprovalAnnotationColor = "red" | "amber" | "blue" | "green" | "custom";

export type ApprovalAnnotation = {
  id: ApprovalAnnotationId;
  approvalId: ApprovalAnnotationId;
  authorUserId: ApprovalAnnotationId;
  authorUsername: string | null;
  authorDisplayName: string | null;
  authorRole: "designer" | "supervisor" | "process" | "admin" | null;
  kind: ApprovalAnnotationKind;
  message: string;
  pageNumber: number;
  xRatio: number;
  yRatio: number;
  widthRatio: number | null;
  heightRatio: number | null;
  endXRatio: number | null;
  endYRatio: number | null;
  pointsJson: string | null;
  styleJson: string | null;
  color: ApprovalAnnotationColor;
  resolved: boolean;
  resolvedByUserId: ApprovalAnnotationId | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  externalId?: string;
  externalApprovalId?: string;
  externalAuthorUserId?: string;
};

export type ApprovalAnnotationInput = {
  kind: ApprovalAnnotationKind;
  message: string;
  pageNumber: number;
  xRatio: number;
  yRatio: number;
  widthRatio?: number | null;
  heightRatio?: number | null;
  endXRatio?: number | null;
  endYRatio?: number | null;
  pointsJson?: string | null;
  styleJson?: string | null;
  color?: ApprovalAnnotationColor;
};
