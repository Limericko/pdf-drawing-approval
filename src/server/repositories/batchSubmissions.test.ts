import { describe, expect, it } from "vitest";
import { createDatabase } from "../db.ts";
import { ApprovalRepository } from "./approvals.ts";
import { BatchSubmissionRepository } from "./batchSubmissions.ts";
import { UserRepository } from "./users.ts";

function repositories() {
  const db = createDatabase(":memory:");
  const users = new UserRepository(db);
  const designer = users.create({ username: "designer", password: "123456", role: "designer", displayName: "设计师" });
  return {
    db,
    designer,
    approvals: new ApprovalRepository(db),
    batches: new BatchSubmissionRepository(db)
  };
}

describe("BatchSubmissionRepository", () => {
  it("starts a batch and records completed and failed items with placement state", () => {
    const { approvals, batches, designer } = repositories();
    const approval = createApproval(approvals, "轴承座", "a0A0");

    const batch = batches.start({
      projectName: "项目A",
      totalCount: 2,
      createdByUserId: designer.id
    });
    batches.addItem({
      batchId: batch.id,
      fileName: "轴承座-a0A0.pdf",
      approvalId: approval.id,
      status: "completed",
      placementState: "manual"
    });
    batches.addItem({
      batchId: batch.id,
      fileName: "端盖-a1A0.pdf",
      status: "failed",
      errorMessage: "INVALID_PDF_FILE",
      placementState: "missing"
    });

    const completed = batches.complete(batch.id);

    expect(completed).toEqual(
      expect.objectContaining({
        id: batch.id,
        projectName: "项目A",
        status: "partial",
        totalCount: 2,
        successCount: 1,
        failedCount: 1
      })
    );
    expect(completed.items.map((item) => item.placementState)).toEqual(["manual", "missing"]);
    expect(completed.items[0]).toEqual(expect.objectContaining({ fileName: "轴承座-a0A0.pdf", approvalId: approval.id }));
    expect(completed.finishedAt).toEqual(expect.any(String));
  });

  it("marks a batch completed when every item succeeds and failed when every item fails", () => {
    const { approvals, batches, designer } = repositories();
    const approval = createApproval(approvals, "轴承座", "a0A0");
    const successBatch = batches.start({ projectName: "项目A", totalCount: 1, createdByUserId: designer.id });
    batches.addItem({
      batchId: successBatch.id,
      fileName: "轴承座-a0A0.pdf",
      approvalId: approval.id,
      status: "completed",
      placementState: "template"
    });

    const failedBatch = batches.start({ projectName: "项目B", totalCount: 1, createdByUserId: designer.id });
    batches.addItem({
      batchId: failedBatch.id,
      fileName: "错误.pdf",
      status: "failed",
      errorMessage: "SIGNATURE_PLACEMENTS_REQUIRED",
      placementState: "missing"
    });

    expect(batches.complete(successBatch.id).status).toBe("completed");
    expect(batches.complete(failedBatch.id).status).toBe("failed");
  });

  it("fails a running batch with a batch-level error", () => {
    const { batches, designer } = repositories();
    const batch = batches.start({ projectName: "项目A", totalCount: 3, createdByUserId: designer.id });

    const failed = batches.fail(batch.id, "WATCH_ROOT_NOT_CONFIGURED");

    expect(failed).toEqual(
      expect.objectContaining({
        status: "failed",
        successCount: 0,
        failedCount: 3
      })
    );
    expect(failed.items).toHaveLength(0);
    expect(failed.errorMessage).toBe("WATCH_ROOT_NOT_CONFIGURED");
  });

  it("lists recent batches newest first and can return a batch with items", () => {
    const { approvals, batches, designer } = repositories();
    const approval = createApproval(approvals, "端盖", "a0A0");
    const first = batches.start({ projectName: "项目A", totalCount: 1, createdByUserId: designer.id });
    const second = batches.start({ projectName: "项目B", totalCount: 1, createdByUserId: designer.id });
    batches.addItem({ batchId: second.id, fileName: "端盖-a0A0.pdf", status: "completed", approvalId: approval.id, placementState: "manual" });

    expect(batches.listRecent(1).map((batch) => batch.id)).toEqual([second.id]);
    expect(batches.getWithItems(second.id)?.items).toEqual([
      expect.objectContaining({ fileName: "端盖-a0A0.pdf", status: "completed" })
    ]);
    expect(batches.getWithItems(first.id)?.items).toEqual([]);
  });

  it("deletes failed and partial batch submissions older than a cutoff", () => {
    const { db, approvals, batches, designer } = repositories();
    const approval = createApproval(approvals, "端盖", "a0A0");
    const oldFailed = batches.start({ projectName: "项目A", totalCount: 1, createdByUserId: designer.id });
    batches.addItem({ batchId: oldFailed.id, fileName: "错误.pdf", status: "failed", errorMessage: "INVALID_PDF_FILE" });
    batches.complete(oldFailed.id);
    const oldPartial = batches.start({ projectName: "项目B", totalCount: 2, createdByUserId: designer.id });
    batches.addItem({ batchId: oldPartial.id, fileName: "端盖-a0A0.pdf", approvalId: approval.id, status: "completed" });
    batches.addItem({ batchId: oldPartial.id, fileName: "错误.pdf", status: "failed", errorMessage: "INVALID_PDF_FILE" });
    batches.complete(oldPartial.id);
    const recentFailed = batches.start({ projectName: "项目C", totalCount: 1, createdByUserId: designer.id });
    batches.fail(recentFailed.id, "WATCH_ROOT_NOT_CONFIGURED");
    db.prepare("UPDATE batch_submissions SET created_at = ? WHERE id IN (?, ?)").run("2026-01-01T00:00:00.000Z", oldFailed.id, oldPartial.id);

    expect(batches.countFailedOlderThan(new Date("2026-02-01T00:00:00.000Z"))).toBe(2);
    expect(batches.deleteFailedOlderThan(new Date("2026-02-01T00:00:00.000Z"))).toBe(2);
    expect(batches.listRecent().map((batch) => batch.id)).toEqual([recentFailed.id]);
  });
});

function createApproval(approvals: ApprovalRepository, partName: string, version: string) {
  return approvals.create({
    projectName: "项目A",
    partName,
    version,
    minorVersion: version.slice(0, 2),
    majorVersion: version.slice(2),
    originalFilePath: `${partName}-${version}.pdf`,
    currentFilePath: `${partName}-${version}.pdf`
  });
}
