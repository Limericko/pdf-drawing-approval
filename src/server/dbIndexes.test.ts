import { describe, expect, it } from "vitest";
import { createDatabase } from "./db.ts";

describe("database indexes", () => {
  it("creates approval indexes used by V7 list, risk, and version queries", () => {
    const db = createDatabase(":memory:");
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
      .all() as Array<{ name: string }>;

    expect(indexes.map((item) => item.name)).toEqual(
      expect.arrayContaining([
        "idx_approvals_status_submitted",
        "idx_approvals_signature_status_submitted",
        "idx_approvals_project_part_submitted",
        "idx_approvals_current_file_path",
        "idx_approvals_submitted_by_user",
        "idx_operation_logs_target_created_id",
        "idx_operation_logs_created_id"
      ])
    );
  });

  it("keeps operation log indexes aligned with timeline and admin log ordering", () => {
    const db = createDatabase(":memory:");
    const indexColumns = (name: string) =>
      (
        db.prepare(`PRAGMA index_info(${name})`).all() as Array<{
          name: string;
        }>
      ).map((column) => column.name);

    expect(indexColumns("idx_operation_logs_target_created_id")).toEqual(["target_type", "target_id", "created_at", "id"]);
    expect(indexColumns("idx_operation_logs_created_id")).toEqual(["created_at", "id"]);
  });
});
