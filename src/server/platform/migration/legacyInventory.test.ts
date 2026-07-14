import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { inspectLegacyDatabase } from "./legacyInventory.ts";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe("legacy SQLite inventory", () => {
  it("fingerprints a complete read-only legacy schema without changing the source", async () => {
    const databasePath = await fixture();
    const before = await digest(databasePath);
    const report = await inspectLegacyDatabase({ databasePath, sourceId: "legacy-production",
      now: () => new Date("2026-07-14T13:30:00.000Z") });

    expect(report).toMatchObject({
      schemaVersion: 1,
      sourceId: "legacy-production",
      generatedAt: "2026-07-14T13:30:00.000Z",
      database: { quickCheck: "ok", foreignKeyViolationCount: 0 },
      users: { total: 0, active: 0, activeWithoutEmail: 0, duplicateNormalizedEmails: 0 },
      projects: { distinct: 0, blankNames: 0 },
      fileReferences: { distinct: 0 },
      blockingIssueCount: 0,
      eligibleForPreflight: true
    });
    expect(report.database.tables.approvals).toBe(0);
    expect(report.source.fingerprintSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.source.schemaSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await digest(databasePath)).toBe(before);
  });

  it("reports unknown states, missing identity data, malformed JSON and foreign-key violations", async () => {
    const databasePath = await fixture((database) => {
      database.exec("PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON;");
      database.prepare(
        "INSERT INTO users(username,password_hash,role,email,display_name,active) VALUES(?,?,?,?,?,?)"
      ).run("missing-email", "secret-hash", "designer", null, "缺少邮箱", 1);
      database.prepare(
        "INSERT INTO users(username,password_hash,role,email,display_name,active) VALUES(?,?,?,?,?,?)"
      ).run("duplicate-a", "secret-hash", "supervisor", "DUP@example.com", "主管甲", 1);
      database.prepare(
        "INSERT INTO users(username,password_hash,role,email,display_name,active) VALUES(?,?,?,?,?,?)"
      ).run("duplicate-b", "secret-hash", "process", "dup@example.com", "工艺乙", 1);
      database.prepare(
        "INSERT INTO user_preferences(user_id,common_projects_json,notification_preferences_json) VALUES(?,?,?)"
      ).run(1, "not-json", "{}");
      database.prepare(
        `INSERT INTO approvals(project_name,part_name,version,minor_version,major_version,
          original_file_path,current_file_path,status) VALUES(?,?,?,?,?,?,?,?)`
      ).run("项目 A", "阀体", "a0A0", "a0", "A0", "C:/drawings/a.pdf", "C:/drawings/a.pdf", "unknown");
      database.prepare(
        "INSERT INTO signature_assets(user_id,kind,file_path,active) VALUES(?,?,?,?)"
      ).run(999, "uploaded_png", "C:/signatures/missing.png", 1);
    });

    const report = await inspectLegacyDatabase({ databasePath, sourceId: "legacy-production" });
    expect(report.eligibleForPreflight).toBe(false);
    expect(report.users).toMatchObject({ total: 3, active: 3, activeWithoutEmail: 1,
      duplicateNormalizedEmails: 1 });
    expect(report.projects.distinct).toBe(1);
    expect(report.fileReferences.distinct).toBe(2);
    expect(report.database.foreignKeyViolationCount).toBeGreaterThan(0);
    expect(report.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "SQLITE_FOREIGN_KEY_VIOLATION", "LEGACY_STATE_UNKNOWN", "LEGACY_JSON_INVALID",
      "ACTIVE_USER_EMAIL_MISSING", "USER_EMAIL_DUPLICATE"
    ]));
    expect(JSON.stringify(report)).not.toContain("secret-hash");
  });

  it("treats absent additive feature tables as an explicit zero-data warning", async () => {
    const databasePath = await fixture((database) => {
      database.exec("DROP TABLE approval_issue_events; DROP TABLE approval_issues;");
    });
    const report = await inspectLegacyDatabase({ databasePath, sourceId: "legacy-production" });
    expect(report.eligibleForPreflight).toBe(true);
    expect(report.issues).toContainEqual(expect.objectContaining({
      severity: "warning",
      code: "LEGACY_OPTIONAL_TABLE_MISSING",
      count: 2,
      details: ["approval_issues", "approval_issue_events"]
    }));
  });

  it("rejects relative, missing and symbolic-link sources", async () => {
    await expect(inspectLegacyDatabase({ databasePath: "relative.sqlite", sourceId: "legacy-production" }))
      .rejects.toMatchObject({ code: "LEGACY_INVENTORY_INPUT_INVALID", field: "databasePath" });
    const root = await tempRoot();
    await expect(inspectLegacyDatabase({ databasePath: path.join(root, "missing.sqlite"), sourceId: "legacy-production" }))
      .rejects.toMatchObject({ code: "LEGACY_INVENTORY_INPUT_INVALID", field: "databasePath" });
  });
});

async function fixture(seed?: (database: DatabaseSync) => void) {
  const root = await tempRoot();
  const databasePath = path.join(root, "legacy.sqlite");
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(await readFile(path.resolve("src/server/schema.sql"), "utf8"));
    seed?.(database);
  } finally {
    database.close();
  }
  return databasePath;
}

async function tempRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "pdf-approval-legacy-inventory-"));
  cleanup.push(root);
  return root;
}

async function digest(filePath: string) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}
