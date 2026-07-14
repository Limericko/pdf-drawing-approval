import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../../src/server/db.ts";
import { ApprovalRepository } from "../../src/server/repositories/approvals.ts";
import { SignatureAssetRepository } from "../../src/server/repositories/signatureAssets.ts";
import { UserRepository } from "../../src/server/repositories/users.ts";
import { seedE2eData } from "./seed.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("seedE2eData", () => {
  it("creates isolated users, signatures, a valid PDF, and a pending approval", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-approval-e2e-"));
    roots.push(root);
    const seeded = await seedE2eData(root);
    const db = createDatabase(seeded.databasePath);
    try {
      const users = new UserRepository(db);
      const approvals = new ApprovalRepository(db);
      const signatures = new SignatureAssetRepository(db);

      const designer = users.findByUsername("designer_e2e");
      const approval = approvals.getById(seeded.approvalId);
      const longApproval = approvals.getById(seeded.longApprovalId);
      const databaseRelativePath = path.relative(root, seeded.databasePath);
      expect(designer?.role).toBe("designer");
      expect(signatures.getActiveForUser(designer!.id)).not.toBeNull();
      expect(approval?.partName).toBe("E2E轴承座");
      expect(approval?.status).toBe("pending");
      expect(fs.readFileSync(seeded.pdfPath).subarray(0, 4).toString()).toBe("%PDF");
      expect(longApproval?.partName).toBe("E2E长文档");
      expect(fs.readFileSync(seeded.longPdfPath).subarray(0, 4).toString()).toBe("%PDF");
      expect(path.isAbsolute(databaseRelativePath)).toBe(false);
      expect(databaseRelativePath).not.toBe("..");
      expect(databaseRelativePath.startsWith(`..${path.sep}`)).toBe(false);
    } finally {
      db.close();
    }
  });

  it("closes the database when reseeding fails", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-approval-e2e-"));
    roots.push(root);
    await seedE2eData(root);

    await expect(seedE2eData(root)).rejects.toThrow(/UNIQUE constraint failed: users\.username/);
    expect(() => fs.rmSync(root, { recursive: true, force: true })).not.toThrow();
    fs.mkdirSync(root, { recursive: true });
    expect(fs.existsSync(root)).toBe(true);
  });
});
