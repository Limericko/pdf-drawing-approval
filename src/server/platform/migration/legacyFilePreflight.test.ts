import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PDFDocument } from "pdf-lib";
import { afterEach, describe, expect, it } from "vitest";
import { preflightLegacyFiles } from "./legacyFilePreflight.ts";

const cleanup: string[] = [];
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64"
);

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe("legacy file preflight", () => {
  it("maps legacy roots, deduplicates references and parses PDF and PNG content", async () => {
    const context = await fixture();
    const report = await preflightLegacyFiles({ databasePath: context.databasePath,
      roots: [{ legacyRoot: "X:\\legacy", snapshotRoot: context.filesRoot }],
      now: () => new Date("2026-07-14T14:00:00.000Z") });

    expect(report).toMatchObject({ schemaVersion: 1, generatedAt: "2026-07-14T14:00:00.000Z",
      references: 3, uniquePaths: 2, verifiedFiles: 2, blockingIssueCount: 0, eligibleForImport: true });
    expect(report.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ relativePath: "drawings/a.pdf", mediaType: "application/pdf", pageCount: 1,
        referenceCount: 2 }),
      expect.objectContaining({ relativePath: "signatures/a.png", mediaType: "image/png", referenceCount: 1 })
    ]));
    expect(report.files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256))).toBe(true);
  });

  it("reports outside-root, missing and invalid-media files without exposing the source path", async () => {
    const context = await fixture({ pdfPath: "Y:\\outside\\a.pdf", pngPath: "X:\\legacy\\missing.png",
      pdfBytes: Buffer.from("not-a-pdf") });
    const report = await preflightLegacyFiles({ databasePath: context.databasePath,
      roots: [{ legacyRoot: "X:\\legacy", snapshotRoot: context.filesRoot }] });
    expect(report.eligibleForImport).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "FILE_PATH_OUTSIDE_ROOT", "FILE_MISSING"
    ]));
    expect(JSON.stringify(report)).not.toContain("Y:\\outside");
  });

  it("rejects a file with the expected extension but invalid PDF content", async () => {
    const context = await fixture({ pdfBytes: Buffer.from("%PDF-not-parseable") });
    const report = await preflightLegacyFiles({ databasePath: context.databasePath,
      roots: [{ legacyRoot: "X:\\legacy", snapshotRoot: context.filesRoot }] });
    expect(report.eligibleForImport).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({ code: "FILE_MEDIA_INVALID", referenceCount: 2 }));
  });

  it("rejects a symbolic-link or non-directory snapshot root", async () => {
    const context = await fixture();
    await expect(preflightLegacyFiles({ databasePath: context.databasePath,
      roots: [{ legacyRoot: "X:\\legacy", snapshotRoot: path.join(context.filesRoot, "drawings", "a.pdf") }] }))
      .rejects.toMatchObject({ code: "LEGACY_FILE_PREFLIGHT_INPUT_INVALID", field: "roots" });
  });
});

async function fixture(options: { pdfPath?: string; pngPath?: string; pdfBytes?: Buffer } = {}) {
  const root = await tempRoot();
  const filesRoot = path.join(root, "files");
  await mkdir(path.join(filesRoot, "drawings"), { recursive: true });
  await mkdir(path.join(filesRoot, "signatures"), { recursive: true });
  const pdf = options.pdfBytes ?? await pdfBytes();
  await writeFile(path.join(filesRoot, "drawings", "a.pdf"), pdf);
  await writeFile(path.join(filesRoot, "signatures", "a.png"), png);
  const databasePath = path.join(root, "legacy.sqlite");
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(await readFile(path.resolve("src/server/schema.sql"), "utf8"));
    database.prepare(
      "INSERT INTO users(username,password_hash,role,email,display_name,active) VALUES(?,?,?,?,?,?)"
    ).run("designer", "hash", "designer", "designer@example.test", "设计师", 1);
    const pdfPath = options.pdfPath ?? "X:\\legacy\\drawings\\a.pdf";
    database.prepare(
      `INSERT INTO approvals(project_name,part_name,version,minor_version,major_version,
        original_file_path,current_file_path,status) VALUES(?,?,?,?,?,?,?,?)`
    ).run("项目 A", "阀体", "a0A0", "a0", "A0", pdfPath, pdfPath, "pending");
    database.prepare("INSERT INTO signature_assets(user_id,kind,file_path,active) VALUES(?,?,?,?)")
      .run(1, "uploaded_png", options.pngPath ?? "X:\\legacy\\signatures\\a.png", 1);
  } finally {
    database.close();
  }
  return { databasePath, filesRoot };
}

async function pdfBytes() {
  const document = await PDFDocument.create();
  document.addPage([400, 300]);
  return Buffer.from(await document.save());
}

async function tempRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "pdf-approval-legacy-files-"));
  cleanup.push(root);
  return root;
}
