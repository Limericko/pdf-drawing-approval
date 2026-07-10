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
    const users = new UserRepository(db);
    const approvals = new ApprovalRepository(db);
    const signatures = new SignatureAssetRepository(db);

    const designer = users.findByUsername("designer_e2e");
    expect(designer?.role).toBe("designer");
    expect(signatures.getActiveForUser(designer!.id)).not.toBeNull();
    expect(approvals.getById(seeded.approvalId)?.partName).toBe("E2E轴承座");
    expect(fs.readFileSync(seeded.pdfPath).subarray(0, 4).toString()).toBe("%PDF");
    expect(seeded.databasePath.startsWith(root)).toBe(true);
    db.close();
  });
});
