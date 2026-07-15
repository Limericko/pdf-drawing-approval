import { describe, expect, it } from "vitest";
import { platformAnnotationToWorkspace, workspaceAnnotationToPlatform } from "./platformAnnotationAdapter.ts";

const ids = {
  issue: "01890f1e-9b4a-7cc2-8f00-000000001101",
  approval: "01890f1e-9b4a-7cc2-8f00-000000001102",
  author: "01890f1e-9b4a-7cc2-8f00-000000001103"
} as const;

describe("platform annotation adapter", () => {
  it("converts v2 geometry and UUID identity into the PDF marker model", () => {
    const annotation = {
      id: ids.issue, projectId: "01890f1e-9b4a-7cc2-8f00-000000001104", approvalCaseId: ids.approval,
      authorUserId: ids.author, kind: "rect" as const, pageNumber: 2,
      geometry: { xRatio: 0.2, yRatio: 0.3, widthRatio: 0.25, heightRatio: 0.1 },
      style: { color: "amber" }, message: "核对孔位", resolved: false, version: 1,
      createdAt: "2026-07-14T05:00:00.000Z", updatedAt: "2026-07-14T05:00:00.000Z"
    };
    const issue = { id: "01890f1e-9b4a-7cc2-8f00-000000001105", projectId: annotation.projectId,
      approvalCaseId: ids.approval, annotationId: ids.issue, annotation, creatorUserId: ids.author,
      assigneeUserId: ids.author, title: "孔位", description: "核对孔位", severity: "medium" as const,
      status: "open" as const, dueAt: null, version: 1, createdAt: annotation.createdAt, updatedAt: annotation.updatedAt };
    const result = platformAnnotationToWorkspace(annotation, issue);
    expect(result).toMatchObject({ pageNumber: 2, xRatio: 0.2, widthRatio: 0.25, color: "amber",
      externalId: ids.issue, externalApprovalId: ids.approval });
    expect(typeof result.id).toBe("number");
  });

  it("keeps editable ratios and style metadata in the v2 issue payload", () => {
    expect(workspaceAnnotationToPlatform({ kind: "arrow", message: "检查", pageNumber: 1,
      xRatio: 0.1, yRatio: 0.2, endXRatio: 0.8, endYRatio: 0.7, color: "blue",
      styleJson: JSON.stringify({ strokeWidth: 2 }) })).toEqual({
      kind: "arrow", pageNumber: 1,
      geometry: { xRatio: 0.1, yRatio: 0.2, widthRatio: null, heightRatio: null, endXRatio: 0.8, endYRatio: 0.7 },
      style: { strokeWidth: 2, color: "blue" }, message: "检查"
    });
  });
});
