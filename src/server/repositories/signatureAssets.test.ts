import { describe, expect, it } from "vitest";
import { createDatabase } from "../db.ts";
import { UserRepository } from "./users.ts";
import { SignatureAssetRepository } from "./signatureAssets.ts";

function repositories() {
  const db = createDatabase(":memory:");
  return {
    users: new UserRepository(db),
    signatures: new SignatureAssetRepository(db)
  };
}

describe("SignatureAssetRepository", () => {
  it("creates and fetches the active signature for a user", () => {
    const { users, signatures } = repositories();
    const designer = users.create({ username: "designer1", password: "123456", role: "designer", displayName: "设计师" });

    const created = signatures.createForUser({
      userId: designer.id,
      kind: "uploaded_png",
      filePath: "data/signatures/1/signature.png"
    });

    expect(created.id).toBeGreaterThan(0);
    expect(created.active).toBe(true);
    expect(created.kind).toBe("uploaded_png");
    expect(signatures.getActiveForUser(designer.id)?.filePath).toBe("data/signatures/1/signature.png");
  });

  it("replaces the active signature for one user", () => {
    const { users, signatures } = repositories();
    const supervisor = users.create({ username: "supervisor1", password: "123456", role: "supervisor", displayName: "主管" });

    const oldSignature = signatures.createForUser({
      userId: supervisor.id,
      kind: "uploaded_png",
      filePath: "data/signatures/1/old.png"
    });
    const newSignature = signatures.replaceActiveForUser({
      userId: supervisor.id,
      kind: "drawn_png",
      filePath: "data/signatures/1/new.png"
    });

    expect(signatures.getById(oldSignature.id)?.active).toBe(false);
    expect(signatures.getActiveForUser(supervisor.id)?.id).toBe(newSignature.id);
    expect(signatures.getActiveForUser(supervisor.id)?.kind).toBe("drawn_png");
  });

  it("lists signature configuration status for all users", () => {
    const { users, signatures } = repositories();
    const designer = users.create({ username: "designer1", password: "123456", role: "designer", displayName: "设计师" });
    const process = users.create({ username: "process1", password: "123456", role: "process", displayName: "工艺" });
    signatures.createForUser({
      userId: designer.id,
      kind: "uploaded_png",
      filePath: "data/signatures/1/signature.png"
    });

    const statuses = signatures.listUserSignatureStatus();

    expect(statuses).toEqual([
      expect.objectContaining({
        userId: designer.id,
        username: "designer1",
        displayName: "设计师",
        role: "designer",
        hasSignature: true
      }),
      expect.objectContaining({
        userId: process.id,
        username: "process1",
        displayName: "工艺",
        role: "process",
        hasSignature: false
      })
    ]);
  });
});
