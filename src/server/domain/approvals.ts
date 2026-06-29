export type ReviewRole = "supervisor" | "process";
export type ReviewDecision = "approved" | "rejected";
export type ReviewStatus = "pending" | ReviewDecision;
export type ApprovalStatus =
  | "pending"
  | "rejected"
  | "approved_for_print"
  | "printed_archived"
  | "filename_invalid"
  | "file_missing"
  | "invalid_pdf"
  | "voided";
export type ApprovalSource = "web_upload" | "folder_watch";
export type SignatureStatus = "not_required" | "placement_required" | "pending" | "ready" | "generated" | "failed";
export type PdmMetadataStatus = "complete" | "missing_material_code" | "missing_document_code" | "missing_required";
export type PdmPublishStatus = "not_applicable" | "metadata_pending" | "pending" | "published" | "failed";

export type Approval = {
  id: number;
  projectName: string;
  partName: string;
  version: string;
  minorVersion: string;
  majorVersion: string;
  originalFilePath: string;
  currentFilePath: string;
  status: ApprovalStatus;
  submittedBy: string | null;
  submittedByUserId: number | null;
  source: ApprovalSource;
  originalFileHash: string | null;
  signedFilePath: string | null;
  signedFileHash: string | null;
  signedAt: string | null;
  signatureStatus: SignatureStatus;
  signatureError: string | null;
  documentCode: string | null;
  materialCode: string | null;
  drawingName: string | null;
  pdmRevisionId: number | null;
  pdmMetadataStatus: PdmMetadataStatus;
  pdmPublishStatus: PdmPublishStatus;
  pdmPublishError: string | null;
  submittedAt: string;
  supervisorStatus: ReviewStatus;
  supervisorComment: string | null;
  supervisorReviewedAt: string | null;
  processStatus: ReviewStatus;
  processComment: string | null;
  processReviewedAt: string | null;
  printedAt: string | null;
  archivedAt: string | null;
};

export type CreateApprovalInput = {
  projectName: string;
  partName: string;
  version: string;
  minorVersion: string;
  majorVersion: string;
  originalFilePath: string;
  currentFilePath: string;
  status?: ApprovalStatus;
  submittedBy?: string | null;
  submittedByUserId?: number | null;
  source?: ApprovalSource;
  originalFileHash?: string | null;
  signatureStatus?: SignatureStatus;
  documentCode?: string | null;
  materialCode?: string | null;
  drawingName?: string | null;
  pdmMetadataStatus?: PdmMetadataStatus;
  pdmPublishStatus?: PdmPublishStatus;
  pdmPublishError?: string | null;
};

export type ReviewInput = {
  role: ReviewRole;
  decision: ReviewDecision;
  comment?: string | null;
  allowEmptyRejectComment?: boolean;
};

export function deriveApprovalStatus(supervisor: ReviewStatus, process: ReviewStatus): ApprovalStatus {
  if (supervisor === "rejected" || process === "rejected") {
    return "rejected";
  }

  if (supervisor === "approved" && process === "approved") {
    return "approved_for_print";
  }

  return "pending";
}
