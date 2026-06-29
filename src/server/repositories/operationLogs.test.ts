import { describe, expect, it } from "vitest";
import { createDatabase } from "../db.ts";
import { OperationLogRepository } from "./operationLogs.ts";

function repo() {
  return new OperationLogRepository(createDatabase(":memory:"));
}

describe("OperationLogRepository", () => {
  it("creates and lists recent operation logs", () => {
    const repository = repo();

    const created = repository.create({
      actorUserId: 1,
      actorUsername: "admin",
      action: "approval.created",
      targetType: "approval",
      targetId: 12,
      message: "创建审批单",
      metadata: { partName: "轴承座" }
    });

    expect(created.id).toBeGreaterThan(0);
    expect(created.metadata).toEqual({ partName: "轴承座" });
    expect(repository.listRecent()).toHaveLength(1);
  });

  it("lists logs for one target only", () => {
    const repository = repo();
    repository.create({
      action: "approval.created",
      targetType: "approval",
      targetId: 1,
      message: "审批 1"
    });
    repository.create({
      action: "approval.created",
      targetType: "approval",
      targetId: 2,
      message: "审批 2"
    });

    expect(repository.listForTarget("approval", 1).map((log) => log.message)).toEqual(["审批 1"]);
  });
});
