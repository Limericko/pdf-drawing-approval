import { describe, expect, it } from "vitest";
import { createDatabase } from "../db.ts";
import { ApprovalRepository } from "./approvals.ts";
import { SignaturePlacementRepository } from "./signaturePlacements.ts";

function repositories() {
  const db = createDatabase(":memory:");
  return {
    approvals: new ApprovalRepository(db),
    placements: new SignaturePlacementRepository(db)
  };
}

function createApproval(approvals: ApprovalRepository) {
  return approvals.create({
    projectName: "项目A",
    partName: "签名件",
    version: "a0A0",
    minorVersion: "a0",
    majorVersion: "A0",
    originalFilePath: "02-审批中/项目A/签名件-a0A0.pdf",
    currentFilePath: "02-审批中/项目A/签名件-a0A0.pdf"
  });
}

describe("SignaturePlacementRepository", () => {
  it("upserts and lists placements for all required signature roles", () => {
    const { approvals, placements } = repositories();
    const approval = createApproval(approvals);

    placements.upsertMany(approval.id, [
      { role: "designer", pageNumber: 1, xRatio: 0.62, yRatio: 0.82, widthRatio: 0.1, heightRatio: 0.05 },
      { role: "supervisor", pageNumber: 1, xRatio: 0.74, yRatio: 0.82, widthRatio: 0.1, heightRatio: 0.05 },
      { role: "process", pageNumber: 1, xRatio: 0.86, yRatio: 0.82, widthRatio: 0.1, heightRatio: 0.05 }
    ]);

    expect(placements.hasRequiredPlacements(approval.id)).toBe(true);
    expect(placements.listForApproval(approval.id).map((placement) => placement.role)).toEqual([
      "designer",
      "supervisor",
      "process"
    ]);
  });

  it("updates an existing placement by approval and role", () => {
    const { approvals, placements } = repositories();
    const approval = createApproval(approvals);

    placements.upsertMany(approval.id, [
      { role: "designer", pageNumber: 1, xRatio: 0.6, yRatio: 0.8, widthRatio: 0.1, heightRatio: 0.05 }
    ]);
    placements.upsertMany(approval.id, [
      { role: "designer", pageNumber: 2, xRatio: 0.2, yRatio: 0.3, widthRatio: 0.15, heightRatio: 0.08 }
    ]);

    expect(placements.listForApproval(approval.id)).toEqual([
      expect.objectContaining({
        role: "designer",
        pageNumber: 2,
        xRatio: 0.2,
        yRatio: 0.3,
        widthRatio: 0.15,
        heightRatio: 0.08
      })
    ]);
  });

  it("requires designer supervisor and process placements", () => {
    const { approvals, placements } = repositories();
    const approval = createApproval(approvals);

    placements.upsertMany(approval.id, [
      { role: "designer", pageNumber: 1, xRatio: 0.62, yRatio: 0.82, widthRatio: 0.1, heightRatio: 0.05 },
      { role: "supervisor", pageNumber: 1, xRatio: 0.74, yRatio: 0.82, widthRatio: 0.1, heightRatio: 0.05 }
    ]);

    expect(placements.hasRequiredPlacements(approval.id)).toBe(false);
  });

  it("rejects invalid placement roles and ratios", () => {
    const { approvals, placements } = repositories();
    const approval = createApproval(approvals);

    expect(() =>
      placements.upsertMany(approval.id, [
        { role: "printer" as never, pageNumber: 1, xRatio: 0.5, yRatio: 0.5, widthRatio: 0.1, heightRatio: 0.1 }
      ])
    ).toThrow("INVALID_SIGNATURE_ROLE");

    expect(() =>
      placements.upsertMany(approval.id, [
        { role: "designer", pageNumber: 1, xRatio: 0.95, yRatio: 0.5, widthRatio: 0.1, heightRatio: 0.1 }
      ])
    ).toThrow("INVALID_SIGNATURE_PLACEMENT");

    expect(() =>
      placements.upsertMany(approval.id, [
        { role: "designer", pageNumber: 0, xRatio: 0.5, yRatio: 0.5, widthRatio: 0.1, heightRatio: 0.1 }
      ])
    ).toThrow("INVALID_SIGNATURE_PLACEMENT");
  });
});
