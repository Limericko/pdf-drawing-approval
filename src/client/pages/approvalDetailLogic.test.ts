import { describe, expect, it } from "vitest";
import * as approvalDetailLogic from "./approvalDetailLogic.ts";
import {
  canRegenerateSignedPdf,
  canEditSignaturePlacements,
  canShowSignaturePlacementPanel,
  detailReloadErrorMessage,
  filterAnnotations,
  shouldRefreshPdfState,
  signaturePlacementSaveMessage,
  timelinePreviewLimit,
  visibleOperationLogs
} from "./approvalDetailLogic.ts";
import type { Approval, ApprovalAnnotation, OperationLog, User } from "../api.ts";

const editableApproval = {
  status: "pending",
  signatureStatus: "placement_required"
} as Approval;

describe("approval detail signature placement logic", () => {
  it("lets admins and designers edit signature placements before archive", () => {
    expect(canEditSignaturePlacements({ role: "admin" } as User, editableApproval)).toBe(true);
    expect(canEditSignaturePlacements({ role: "designer" } as User, editableApproval)).toBe(true);
    expect(canEditSignaturePlacements({ role: "supervisor" } as User, editableApproval)).toBe(false);
    expect(canEditSignaturePlacements({ role: "process" } as User, editableApproval)).toBe(false);
  });

  it("blocks placement edits after printing or voiding", () => {
    expect(canEditSignaturePlacements({ role: "admin" } as User, { ...editableApproval, status: "printed_archived" })).toBe(false);
    expect(canEditSignaturePlacements({ role: "designer" } as User, { ...editableApproval, status: "voided" })).toBe(false);
  });

  it("shows placement panel when placement is required or the user can edit", () => {
    expect(canShowSignaturePlacementPanel({ role: "supervisor" } as User, editableApproval)).toBe(true);
    expect(canShowSignaturePlacementPanel({ role: "admin" } as User, { ...editableApproval, signatureStatus: "generated" })).toBe(true);
    expect(canShowSignaturePlacementPanel({ role: "printer" } as unknown as User, { ...editableApproval, signatureStatus: "generated" })).toBe(false);
  });

  it("uses a generated-pdf message when saving placements completes signing", () => {
    expect(signaturePlacementSaveMessage({ ...editableApproval, signatureStatus: "generated" })).toBe("签名位置已保存，签后 PDF 已生成。");
    expect(signaturePlacementSaveMessage({ ...editableApproval, signatureStatus: "pending" })).toBe("签名位置已保存。");
  });
});

describe("approval detail traceability layout logic", () => {
  const logs = Array.from({ length: 8 }, (_, index) => ({
    id: index + 1,
    createdAt: `2026-06-17T10:0${index}:00.000Z`
  })) as OperationLog[];

  it("shows the latest operation timeline preview by default", () => {
    expect(timelinePreviewLimit).toBe(5);
    expect(visibleOperationLogs(logs, false)).toEqual(logs.slice(-timelinePreviewLimit));
  });

  it("shows the full operation timeline after expansion", () => {
    expect(visibleOperationLogs(logs, true)).toEqual(logs);
  });

  it("uses related versions for the history panel when available", () => {
    const relatedVersionsForPanel = (
      approvalDetailLogic as unknown as { relatedVersionsForPanel?: (approval: Approval) => Approval[] }
    ).relatedVersionsForPanel;
    const related = [{ id: 2, version: "a1A0" }] as Approval[];
    const history = [{ id: 1, version: "a0A0" }, ...related] as Approval[];

    expect(relatedVersionsForPanel).toBeTypeOf("function");
    expect(relatedVersionsForPanel!({ history, relatedVersions: related } as Approval)).toEqual(related);
  });
});

describe("approval detail refresh decisions", () => {
  const base = {
    id: 1,
    status: "pending",
    signatureStatus: "pending",
    currentFilePath: "G:\\test\\a.pdf",
    signedFilePath: null,
    signedAt: null,
    archivedAt: null
  } as Approval;

  it("rechecks PDF state only for file or lifecycle changes", () => {
    expect(shouldRefreshPdfState(null, base)).toBe(true);
    expect(shouldRefreshPdfState(base, { ...base, supervisorStatus: "approved" } as Approval)).toBe(false);
    expect(shouldRefreshPdfState(base, { ...base, currentFilePath: "G:\\test\\b.pdf" } as Approval)).toBe(true);
    expect(shouldRefreshPdfState(base, { ...base, status: "approved_for_print" } as Approval)).toBe(true);
    expect(shouldRefreshPdfState(base, { ...base, signatureStatus: "generated" } as Approval)).toBe(true);
    expect(shouldRefreshPdfState(base, { ...base, signedFilePath: "G:\\test\\a-signed.pdf" } as Approval)).toBe(true);
    expect(shouldRefreshPdfState(base, { ...base, archivedAt: "2026-06-24T00:00:00.000Z" } as Approval)).toBe(true);
  });

  it("uses a stable fallback for unknown detail reload errors", () => {
    expect(detailReloadErrorMessage(new Error("HTTP_500"))).toBe("HTTP_500");
    expect(detailReloadErrorMessage("boom")).toBe("图纸详情加载失败，请刷新重试。");
  });
});

describe("approval detail signed PDF permissions", () => {
  it("lets designers and admins regenerate signed PDFs before printing", () => {
    const approved = { status: "approved_for_print", signatureStatus: "generated" } as Approval;

    expect(canRegenerateSignedPdf({ role: "designer" } as User, approved)).toBe(true);
    expect(canRegenerateSignedPdf({ role: "admin" } as User, approved)).toBe(true);
    expect(canRegenerateSignedPdf({ role: "supervisor" } as User, approved)).toBe(false);
    expect(canRegenerateSignedPdf({ role: "process" } as User, approved)).toBe(false);
  });

  it("blocks signed PDF regeneration after archive or when signing is not required", () => {
    expect(
      canRegenerateSignedPdf({ role: "designer" } as User, {
        status: "printed_archived",
        signatureStatus: "generated"
      } as Approval)
    ).toBe(false);
    expect(
      canRegenerateSignedPdf({ role: "admin" } as User, {
        status: "approved_for_print",
        signatureStatus: "not_required"
      } as Approval)
    ).toBe(false);
  });
});

describe("approval detail signature template permissions", () => {
  it("exposes save-as-template actions only to designers and admins", () => {
    const canSaveSignatureTemplate = (
      approvalDetailLogic as unknown as { canSaveSignatureTemplate?: (user: Pick<User, "role">) => boolean }
    ).canSaveSignatureTemplate;

    expect(canSaveSignatureTemplate).toBeTypeOf("function");
    expect(canSaveSignatureTemplate!({ role: "designer" } as User)).toBe(true);
    expect(canSaveSignatureTemplate!({ role: "admin" } as User)).toBe(true);
    expect(canSaveSignatureTemplate!({ role: "supervisor" } as User)).toBe(false);
    expect(canSaveSignatureTemplate!({ role: "process" } as User)).toBe(false);
  });
});

describe("approval detail annotation permissions", () => {
  const annotation = {
    id: 8,
    approvalId: 4,
    authorUserId: 2,
    resolved: false
  } as ApprovalAnnotation;
  const pending = { status: "pending" } as Approval;

  it("lets reviewers and admins create annotations on editable approvals", () => {
    const canCreateAnnotation = (
      approvalDetailLogic as unknown as { canCreateAnnotation?: (user: Pick<User, "role">, approval: Pick<Approval, "status">) => boolean }
    ).canCreateAnnotation;

    expect(canCreateAnnotation).toBeTypeOf("function");
    expect(canCreateAnnotation!({ role: "supervisor" } as User, pending)).toBe(true);
    expect(canCreateAnnotation!({ role: "process" } as User, pending)).toBe(true);
    expect(canCreateAnnotation!({ role: "admin" } as User, pending)).toBe(true);
    expect(canCreateAnnotation!({ role: "designer" } as User, pending)).toBe(false);
  });

  it("treats archived and voided approvals as annotation read-only", () => {
    const helpers = approvalDetailLogic as unknown as {
      canCreateAnnotation?: (user: Pick<User, "role">, approval: Pick<Approval, "status">) => boolean;
      canEditAnnotation?: (
        user: Pick<User, "id" | "role">,
        approval: Pick<Approval, "status">,
        annotation: Pick<ApprovalAnnotation, "authorUserId" | "resolved">
      ) => boolean;
      canResolveAnnotation?: (
        user: Pick<User, "id" | "role">,
        approval: Pick<Approval, "status">,
        annotation: Pick<ApprovalAnnotation, "authorUserId" | "resolved">
      ) => boolean;
    };

    expect(helpers.canCreateAnnotation!({ role: "supervisor" } as User, { status: "printed_archived" } as Approval)).toBe(false);
    expect(helpers.canEditAnnotation!({ id: 2, role: "supervisor" } as User, { status: "voided" } as Approval, annotation)).toBe(false);
    expect(helpers.canResolveAnnotation!({ id: 1, role: "designer" } as User, { status: "printed_archived" } as Approval, annotation)).toBe(false);
  });

  it("lets annotation authors and admins edit unresolved annotations", () => {
    const canEditAnnotation = (
      approvalDetailLogic as unknown as {
        canEditAnnotation?: (
          user: Pick<User, "id" | "role">,
          approval: Pick<Approval, "status">,
          annotation: Pick<ApprovalAnnotation, "authorUserId" | "resolved">
        ) => boolean;
      }
    ).canEditAnnotation;

    expect(canEditAnnotation).toBeTypeOf("function");
    expect(canEditAnnotation!({ id: 2, role: "supervisor" } as User, pending, annotation)).toBe(true);
    expect(canEditAnnotation!({ id: 9, role: "admin" } as User, pending, annotation)).toBe(true);
    expect(canEditAnnotation!({ id: 3, role: "process" } as User, pending, annotation)).toBe(false);
    expect(canEditAnnotation!({ id: 2, role: "supervisor" } as User, pending, { ...annotation, resolved: true })).toBe(false);
  });

  it("lets designers, authors, and admins resolve unresolved annotations", () => {
    const canResolveAnnotation = (
      approvalDetailLogic as unknown as {
        canResolveAnnotation?: (
          user: Pick<User, "id" | "role">,
          approval: Pick<Approval, "status">,
          annotation: Pick<ApprovalAnnotation, "authorUserId" | "resolved">
        ) => boolean;
      }
    ).canResolveAnnotation;

    expect(canResolveAnnotation).toBeTypeOf("function");
    expect(canResolveAnnotation!({ id: 1, role: "designer" } as User, pending, annotation)).toBe(true);
    expect(canResolveAnnotation!({ id: 2, role: "supervisor" } as User, pending, annotation)).toBe(true);
    expect(canResolveAnnotation!({ id: 9, role: "admin" } as User, pending, annotation)).toBe(true);
    expect(canResolveAnnotation!({ id: 3, role: "process" } as User, pending, annotation)).toBe(false);
    expect(canResolveAnnotation!({ id: 1, role: "designer" } as User, pending, { ...annotation, resolved: true })).toBe(false);
  });

  it("allows all approval states to display existing annotations", () => {
    const canShowAnnotations = (approvalDetailLogic as unknown as { canShowAnnotations?: (approval: Pick<Approval, "status">) => boolean })
      .canShowAnnotations;

    expect(canShowAnnotations).toBeTypeOf("function");
    expect(canShowAnnotations!(pending)).toBe(true);
    expect(canShowAnnotations!({ status: "printed_archived" } as Approval)).toBe(true);
    expect(canShowAnnotations!({ status: "voided" } as Approval)).toBe(true);
  });

  it("filters annotations by status, author, and kind", () => {
    const items = [
      { ...annotation, id: 1, authorUserId: 2, kind: "arrow", resolved: false },
      { ...annotation, id: 2, authorUserId: 2, kind: "rect", resolved: false },
      { ...annotation, id: 3, authorUserId: 3, kind: "arrow", resolved: false },
      { ...annotation, id: 4, authorUserId: 2, kind: "arrow", resolved: true }
    ] as ApprovalAnnotation[];

    expect(
      filterAnnotations(items, {
        status: "open",
        author: "mine",
        kind: "arrow",
        currentUserId: 2
      }).map((item) => item.id)
    ).toEqual([1]);
  });
});
