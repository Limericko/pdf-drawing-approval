import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { createDatabase } from "../../src/server/db.ts";
import { ApprovalRepository } from "../../src/server/repositories/approvals.ts";
import { SettingsRepository } from "../../src/server/repositories/settings.ts";
import { SignatureAssetRepository } from "../../src/server/repositories/signatureAssets.ts";
import { UserRepository } from "../../src/server/repositories/users.ts";
import { e2eUsers } from "./fixtures.ts";

const transparentPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLz9QAAAABJRU5ErkJggg==",
  "base64"
);

export type E2eSeedResult = {
  rootDir: string;
  dataDir: string;
  databasePath: string;
  watchRoot: string;
  pdfPath: string;
  approvalId: number;
};

export async function seedE2eData(rootDir: string): Promise<E2eSeedResult> {
  const dataDir = path.join(rootDir, "data");
  const watchRoot = path.join(rootDir, "watch");
  const signatureDir = path.join(dataDir, "signatures");
  const databasePath = path.join(dataDir, "pdf-approval.sqlite");
  const pdfPath = path.join(watchRoot, "E2E项目", "E2E轴承座-a0A0.pdf");
  await fs.mkdir(path.dirname(pdfPath), { recursive: true });
  await fs.mkdir(signatureDir, { recursive: true });

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([842, 595]);
  page.drawText("PDF APPROVAL E2E DRAWING", { x: 60, y: 520, size: 24, font });
  page.drawRectangle({ x: 120, y: 180, width: 420, height: 220, borderWidth: 2 });
  const pdfBytes = await pdf.save();
  await fs.writeFile(pdfPath, pdfBytes);

  const db = createDatabase(databasePath);
  try {
    const users = new UserRepository(db);
    const settings = new SettingsRepository(db);
    const approvals = new ApprovalRepository(db);
    const signatures = new SignatureAssetRepository(db);
    users.ensureDefaultUsers();
    const designer = users.create({
      username: e2eUsers.designer.username,
      password: e2eUsers.designer.password,
      role: "designer",
      displayName: "E2E设计师",
      email: "designer-e2e@example.com"
    });

    for (const username of ["supervisor", "process", designer.username]) {
      const user = users.findByUsername(username)!;
      const signaturePath = path.join(signatureDir, `${username}.png`);
      await fs.writeFile(signaturePath, transparentPng);
      signatures.createForUser({ userId: user.id, kind: "uploaded_png", filePath: signaturePath });
    }

    settings.set("watch_root", watchRoot);
    settings.set("app_base_url", "http://127.0.0.1:14173");
    const approval = approvals.create({
      projectName: "E2E项目",
      partName: "E2E轴承座",
      version: "a0A0",
      minorVersion: "a0",
      majorVersion: "A0",
      originalFilePath: pdfPath,
      currentFilePath: pdfPath,
      submittedBy: designer.username,
      submittedByUserId: designer.id,
      source: "web_upload",
      originalFileHash: createHash("sha256").update(pdfBytes).digest("hex"),
      signatureStatus: "not_required",
      documentCode: "E2EDOC0001",
      materialCode: "E2EMAT0001",
      drawingName: "E2E轴承座"
    });

    return { rootDir, dataDir, databasePath, watchRoot, pdfPath, approvalId: approval.id };
  } finally {
    db.close();
  }
}
