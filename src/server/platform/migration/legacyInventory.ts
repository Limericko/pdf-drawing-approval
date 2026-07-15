import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const EXPECTED_TABLES = [
  "users", "user_preferences", "approvals", "pdm_parts", "pdm_drawing_revisions", "pdm_part_usages",
  "settings", "operation_logs", "password_reset_tokens", "scan_runs", "backup_runs", "signature_assets",
  "signature_placements", "approval_comments", "approval_annotations", "approval_issues",
  "approval_issue_events", "signature_templates", "batch_submissions", "batch_submission_items"
] as const;
const REQUIRED_TABLES = ["users", "approvals", "settings"] as const;

const STATE_COLUMNS = [
  ["users", "role", ["designer", "supervisor", "process", "printer", "admin"]],
  ["approvals", "status", ["pending", "rejected", "approved_for_print", "printed_archived", "filename_invalid", "file_missing", "invalid_pdf", "voided"]],
  ["approvals", "source", ["web_upload", "folder_watch"]],
  ["approvals", "signature_status", ["not_required", "placement_required", "pending", "ready", "generated", "failed"]],
  ["approvals", "pdm_metadata_status", ["complete", "missing_material_code", "missing_document_code", "missing_required"]],
  ["approvals", "pdm_publish_status", ["not_applicable", "metadata_pending", "pending", "published", "failed"]],
  ["approvals", "supervisor_status", ["pending", "approved", "rejected"]],
  ["approvals", "process_status", ["pending", "approved", "rejected"]],
  ["pdm_drawing_revisions", "release_status", ["released", "superseded", "voided"]],
  ["approval_issues", "severity", ["low", "medium", "high", "critical"]],
  ["approval_issues", "status", ["open", "in_progress", "review", "closed"]]
] as const;

const JSON_COLUMNS = [
  ["user_preferences", "user_id", "common_projects_json"],
  ["user_preferences", "user_id", "notification_preferences_json"],
  ["operation_logs", "id", "metadata_json"],
  ["approval_annotations", "id", "points_json"],
  ["approval_annotations", "id", "style_json"],
  ["signature_templates", "id", "placements_json"]
] as const;

const FILE_COLUMNS = [
  ["approvals", "original_file_path"], ["approvals", "current_file_path"], ["approvals", "signed_file_path"],
  ["pdm_drawing_revisions", "original_file_path"], ["pdm_drawing_revisions", "signed_file_path"],
  ["pdm_drawing_revisions", "annotated_file_path"], ["signature_assets", "file_path"]
] as const;

export type LegacyInventoryIssue = {
  readonly severity: "blocking" | "warning";
  readonly code: string;
  readonly table?: string;
  readonly column?: string;
  readonly count: number;
  readonly sampleIds?: readonly number[];
  readonly details?: readonly string[];
};

export type LegacyInventoryReport = {
  readonly schemaVersion: 1;
  readonly sourceId: string;
  readonly generatedAt: string;
  readonly source: {
    readonly fileName: string;
    readonly fingerprintSha256: string;
    readonly components: readonly { readonly name: string; readonly sizeBytes: number; readonly sha256: string }[];
    readonly schemaSha256: string;
  };
  readonly database: {
    readonly quickCheck: "ok" | "failed";
    readonly foreignKeyViolationCount: number;
    readonly tables: Readonly<Record<string, number>>;
    readonly unexpectedTables: readonly string[];
  };
  readonly users: {
    readonly total: number;
    readonly active: number;
    readonly activeWithoutEmail: number;
    readonly duplicateNormalizedEmails: number;
    readonly roles: Readonly<Record<string, number>>;
  };
  readonly projects: { readonly distinct: number; readonly blankNames: number };
  readonly fileReferences: { readonly distinct: number; readonly byColumn: Readonly<Record<string, number>> };
  readonly issues: readonly LegacyInventoryIssue[];
  readonly blockingIssueCount: number;
  readonly eligibleForPreflight: boolean;
};

export async function inspectLegacyDatabase(input: {
  readonly databasePath: string;
  readonly sourceId: string;
  readonly now?: () => Date;
}): Promise<LegacyInventoryReport> {
  const databasePath = await validateSource(input?.databasePath);
  const sourceId = validateSourceId(input?.sourceId);
  const source = await fingerprintSource(databasePath);
  const database = new DatabaseSync(databasePath, {
    readOnly: true,
    enableForeignKeyConstraints: false,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false
  });
  try {
    database.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;");
    const tableNames = listTables(database);
    const tableSet = new Set(tableNames);
    const issues: LegacyInventoryIssue[] = [];
    const missingTables = EXPECTED_TABLES.filter((table) => !tableSet.has(table));
    const missingRequired = missingTables.filter((table) => REQUIRED_TABLES.includes(table as never));
    const missingOptional = missingTables.filter((table) => !REQUIRED_TABLES.includes(table as never));
    if (missingRequired.length > 0) issues.push({ severity: "blocking", code: "LEGACY_REQUIRED_TABLE_MISSING",
      count: missingRequired.length, details: Object.freeze([...missingRequired]) });
    if (missingOptional.length > 0) issues.push({ severity: "warning", code: "LEGACY_OPTIONAL_TABLE_MISSING",
      count: missingOptional.length, details: Object.freeze([...missingOptional]) });
    const unexpectedTables = tableNames.filter((table) => !EXPECTED_TABLES.includes(table as never));
    if (unexpectedTables.length > 0) issues.push({ severity: "warning", code: "LEGACY_TABLE_UNEXPECTED",
      count: unexpectedTables.length, details: Object.freeze([...unexpectedTables]) });

    const tables = Object.fromEntries(tableNames.map((table) => [table, count(database, table)]));
    const quickCheckRows = database.prepare("PRAGMA quick_check").all() as { quick_check?: unknown }[];
    const quickCheck: "ok" | "failed" = quickCheckRows.length === 1 && quickCheckRows[0]?.quick_check === "ok"
      ? "ok" : "failed";
    if (quickCheck !== "ok") issues.push({ severity: "blocking", code: "SQLITE_QUICK_CHECK_FAILED",
      count: quickCheckRows.length || 1 });
    const foreignKeyRows = database.prepare("PRAGMA foreign_key_check").all() as Record<string, unknown>[];
    if (foreignKeyRows.length > 0) issues.push({ severity: "blocking", code: "SQLITE_FOREIGN_KEY_VIOLATION",
      count: foreignKeyRows.length, sampleIds: numericSamples(foreignKeyRows, "rowid") });

    for (const [table, column, allowed] of STATE_COLUMNS) {
      if (!tableSet.has(table)) continue;
      const placeholders = allowed.map(() => "?").join(",");
      const rows = database.prepare(
        `SELECT id FROM ${identifier(table)} WHERE ${identifier(column)} IS NULL OR ${identifier(column)} NOT IN (${placeholders}) LIMIT 21`
      ).all(...allowed) as Record<string, unknown>[];
      if (rows.length > 0) issues.push({ severity: "blocking", code: "LEGACY_STATE_UNKNOWN", table, column,
        count: scalarCount(database, `SELECT count(*) AS value FROM ${identifier(table)} WHERE ${identifier(column)} IS NULL OR ${identifier(column)} NOT IN (${placeholders})`, allowed),
        sampleIds: numericSamples(rows, "id") });
    }

    for (const [table, idColumn, valueColumn] of JSON_COLUMNS) {
      if (!tableSet.has(table)) continue;
      const rows = database.prepare(
        `SELECT ${identifier(idColumn)} AS id,${identifier(valueColumn)} AS value FROM ${identifier(table)} WHERE ${identifier(valueColumn)} IS NOT NULL`
      ).all() as { id: unknown; value: unknown }[];
      const invalid = rows.filter((row) => typeof row.value !== "string" || !validJson(row.value));
      if (invalid.length > 0) issues.push({ severity: "blocking", code: "LEGACY_JSON_INVALID", table,
        column: valueColumn, count: invalid.length, sampleIds: numericSamples(invalid, "id") });
    }

    const users = inspectUsers(database, tableSet, issues);
    const projects = inspectProjects(database, tableSet, issues);
    const fileReferences = inspectFileReferences(database, tableSet);
    const blockingIssueCount = issues.filter((issue) => issue.severity === "blocking")
      .reduce((total, issue) => total + issue.count, 0);
    return Object.freeze({
      schemaVersion: 1,
      sourceId,
      generatedAt: (input.now ?? (() => new Date()))().toISOString(),
      source: { ...source, schemaSha256: schemaHash(database) },
      database: { quickCheck, foreignKeyViolationCount: foreignKeyRows.length, tables,
        unexpectedTables: Object.freeze(unexpectedTables) },
      users,
      projects,
      fileReferences,
      issues: Object.freeze(issues.map((issue) => Object.freeze(issue))),
      blockingIssueCount,
      eligibleForPreflight: blockingIssueCount === 0
    });
  } finally {
    database.close();
  }
}

function inspectUsers(database: DatabaseSync, tables: Set<string>, issues: LegacyInventoryIssue[]) {
  if (!tables.has("users")) return { total: 0, active: 0, activeWithoutEmail: 0,
    duplicateNormalizedEmails: 0, roles: {} };
  const total = count(database, "users");
  const active = scalarCount(database, "SELECT count(*) AS value FROM users WHERE active=1");
  const missingRows = database.prepare(
    "SELECT id FROM users WHERE active=1 AND (email IS NULL OR trim(email)='') LIMIT 21"
  ).all() as Record<string, unknown>[];
  const activeWithoutEmail = scalarCount(database,
    "SELECT count(*) AS value FROM users WHERE active=1 AND (email IS NULL OR trim(email)='')");
  if (activeWithoutEmail > 0) issues.push({ severity: "blocking", code: "ACTIVE_USER_EMAIL_MISSING",
    table: "users", column: "email", count: activeWithoutEmail, sampleIds: numericSamples(missingRows, "id") });
  const duplicateRows = database.prepare(
    "SELECT min(id) AS id,count(*) AS value FROM users WHERE email IS NOT NULL AND trim(email)<>'' GROUP BY lower(trim(email)) HAVING count(*)>1"
  ).all() as Record<string, unknown>[];
  const duplicateNormalizedEmails = duplicateRows.reduce((total, row) => total + Number(row.value ?? 0) - 1, 0);
  if (duplicateNormalizedEmails > 0) issues.push({ severity: "blocking", code: "USER_EMAIL_DUPLICATE",
    table: "users", column: "email", count: duplicateNormalizedEmails, sampleIds: numericSamples(duplicateRows, "id") });
  const roles = Object.fromEntries((database.prepare("SELECT role,count(*) AS value FROM users GROUP BY role ORDER BY role")
    .all() as { role: string; value: number }[]).map((row) => [row.role, Number(row.value)]));
  return { total, active, activeWithoutEmail, duplicateNormalizedEmails, roles };
}

function inspectProjects(database: DatabaseSync, tables: Set<string>, issues: LegacyInventoryIssue[]) {
  if (!tables.has("approvals")) return { distinct: 0, blankNames: 0 };
  const distinct = scalarCount(database,
    "SELECT count(DISTINCT trim(project_name)) AS value FROM approvals WHERE trim(project_name)<>''");
  const blankRows = database.prepare("SELECT id FROM approvals WHERE project_name IS NULL OR trim(project_name)='' LIMIT 21")
    .all() as Record<string, unknown>[];
  const blankNames = scalarCount(database,
    "SELECT count(*) AS value FROM approvals WHERE project_name IS NULL OR trim(project_name)=''");
  if (blankNames > 0) issues.push({ severity: "blocking", code: "PROJECT_NAME_MISSING", table: "approvals",
    column: "project_name", count: blankNames, sampleIds: numericSamples(blankRows, "id") });
  return { distinct, blankNames };
}

function inspectFileReferences(database: DatabaseSync, tables: Set<string>) {
  const byColumn: Record<string, number> = {};
  const paths = new Set<string>();
  for (const [table, column] of FILE_COLUMNS) {
    if (!tables.has(table)) continue;
    const rows = database.prepare(
      `SELECT DISTINCT ${identifier(column)} AS value FROM ${identifier(table)} WHERE ${identifier(column)} IS NOT NULL AND trim(${identifier(column)})<>''`
    ).all() as { value: string }[];
    byColumn[`${table}.${column}`] = rows.length;
    for (const row of rows) paths.add(row.value);
  }
  return { distinct: paths.size, byColumn };
}

async function validateSource(value: unknown) {
  if (typeof value !== "string" || value !== value.trim() || !path.isAbsolute(value)) invalid("databasePath");
  let metadata;
  try { metadata = await lstat(value); } catch { invalid("databasePath"); }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0) invalid("databasePath");
  return path.normalize(value);
}

function validateSourceId(value: unknown) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(value)) invalid("sourceId");
  return value;
}

async function fingerprintSource(databasePath: string) {
  const componentPaths = [databasePath, `${databasePath}-wal`];
  const components: { name: string; sizeBytes: number; sha256: string }[] = [];
  for (const candidate of componentPaths) {
    let metadata;
    try { metadata = await stat(candidate); } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    if (!metadata.isFile()) invalid("databasePath");
    components.push({ name: path.basename(candidate), sizeBytes: metadata.size, sha256: await hashFile(candidate) });
  }
  const combined = createHash("sha256");
  for (const component of components) combined.update(component.name).update("\0")
    .update(String(component.sizeBytes)).update("\0").update(component.sha256).update("\0");
  return { fileName: path.basename(databasePath), fingerprintSha256: combined.digest("hex"),
    components: Object.freeze(components.map((component) => Object.freeze(component))) };
}

async function hashFile(filePath: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function schemaHash(database: DatabaseSync) {
  const rows = database.prepare(
    "SELECT type,name,tbl_name,coalesce(sql,'') AS sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"
  ).all() as Record<string, unknown>[];
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

function listTables(database: DatabaseSync) {
  return (database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[]).map((row) => row.name);
}

function count(database: DatabaseSync, table: string) {
  return scalarCount(database, `SELECT count(*) AS value FROM ${identifier(table)}`);
}

function scalarCount(database: DatabaseSync, sql: string, values: readonly unknown[] = []) {
  const row = database.prepare(sql).get(...values as []) as { value?: unknown } | undefined;
  const value = Number(row?.value ?? 0);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("LEGACY_INVENTORY_COUNT_INVALID");
  return value;
}

function numericSamples(rows: readonly Record<string, unknown>[], field: string) {
  return Object.freeze(rows.slice(0, 20).map((row) => Number(row[field])).filter(Number.isSafeInteger));
}

function validJson(value: string) {
  try { JSON.parse(value); return true; } catch { return false; }
}

function identifier(value: string) {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error("LEGACY_INVENTORY_IDENTIFIER_INVALID");
  return `"${value}"`;
}

function invalid(field: string): never {
  const error = new Error("LEGACY_INVENTORY_INPUT_INVALID");
  Object.defineProperty(error, "code", { value: "LEGACY_INVENTORY_INPUT_INVALID", enumerable: true });
  Object.defineProperty(error, "field", { value: field, enumerable: true });
  throw error;
}
