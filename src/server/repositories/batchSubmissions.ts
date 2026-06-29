import type { DatabaseConnection } from "../db.ts";

export type BatchSubmissionStatus = "running" | "completed" | "failed" | "partial";
export type BatchSubmissionItemStatus = "pending" | "completed" | "failed";
export type BatchSubmissionPlacementState = "template" | "manual" | "missing";

export type BatchSubmissionItem = {
  id: number;
  batchId: number;
  fileName: string;
  approvalId: number | null;
  status: BatchSubmissionItemStatus;
  errorMessage: string | null;
  placementState: BatchSubmissionPlacementState | null;
  createdAt: string;
};

export type BatchSubmission = {
  id: number;
  createdByUserId: number | null;
  projectName: string;
  status: BatchSubmissionStatus;
  totalCount: number;
  successCount: number;
  failedCount: number;
  errorMessage: string | null;
  createdAt: string;
  finishedAt: string | null;
};

export type BatchSubmissionWithItems = BatchSubmission & {
  items: BatchSubmissionItem[];
};

type BatchSubmissionRow = {
  id: number;
  created_by_user_id: number | null;
  project_name: string;
  status: BatchSubmissionStatus;
  total_count: number;
  success_count: number;
  failed_count: number;
  error_message: string | null;
  created_at: string;
  finished_at: string | null;
};

type BatchSubmissionItemRow = {
  id: number;
  batch_id: number;
  file_name: string;
  approval_id: number | null;
  status: BatchSubmissionItemStatus;
  error_message: string | null;
  placement_state: BatchSubmissionPlacementState | null;
  created_at: string;
};

export class BatchSubmissionRepository {
  constructor(private readonly db: DatabaseConnection) {}

  start(input: { projectName: string; totalCount: number; createdByUserId?: number | null }): BatchSubmissionWithItems {
    const projectName = input.projectName.trim();
    if (!projectName) throw new Error("BATCH_PROJECT_NAME_REQUIRED");
    if (!Number.isInteger(input.totalCount) || input.totalCount < 1) throw new Error("BATCH_TOTAL_COUNT_INVALID");

    const result = this.db
      .prepare(
        `INSERT INTO batch_submissions (created_by_user_id, project_name, status, total_count)
         VALUES (?, ?, 'running', ?)`
      )
      .run(input.createdByUserId ?? null, projectName, input.totalCount);

    return this.getWithItems(Number(result.lastInsertRowid))!;
  }

  addItem(input: {
    batchId: number;
    fileName: string;
    approvalId?: number | null;
    status: BatchSubmissionItemStatus;
    errorMessage?: string | null;
    placementState?: BatchSubmissionPlacementState | null;
  }): BatchSubmissionItem {
    const fileName = input.fileName.trim();
    if (!fileName) throw new Error("BATCH_ITEM_FILE_NAME_REQUIRED");

    const result = this.db
      .prepare(
        `INSERT INTO batch_submission_items (
          batch_id, file_name, approval_id, status, error_message, placement_state
        ) VALUES (
          @batchId, @fileName, @approvalId, @status, @errorMessage, @placementState
        )`
      )
      .run({
        batchId: input.batchId,
        fileName,
        approvalId: input.approvalId ?? null,
        status: input.status,
        errorMessage: input.errorMessage ?? null,
        placementState: input.placementState ?? null
      });

    return this.getItemById(Number(result.lastInsertRowid))!;
  }

  complete(batchId: number): BatchSubmissionWithItems {
    const items = this.listItems(batchId);
    const successCount = items.filter((item) => item.status === "completed").length;
    const failedCount = items.filter((item) => item.status === "failed").length;
    const status: BatchSubmissionStatus =
      successCount > 0 && failedCount === 0 ? "completed" : successCount === 0 ? "failed" : "partial";

    this.db
      .prepare(
        `UPDATE batch_submissions
         SET status = ?, success_count = ?, failed_count = ?, finished_at = CURRENT_TIMESTAMP, error_message = NULL
         WHERE id = ?`
      )
      .run(status, successCount, failedCount, batchId);

    return this.getWithItems(batchId)!;
  }

  fail(batchId: number, errorMessage: string): BatchSubmissionWithItems {
    const existing = this.getById(batchId);
    if (!existing) throw new Error("BATCH_SUBMISSION_NOT_FOUND");

    this.db
      .prepare(
        `UPDATE batch_submissions
         SET status = 'failed', success_count = 0, failed_count = total_count, error_message = ?, finished_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      )
      .run(errorMessage, batchId);

    return this.getWithItems(batchId)!;
  }

  listRecent(limit = 20): BatchSubmissionWithItems[] {
    const rows = this.db
      .prepare("SELECT * FROM batch_submissions ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(limit) as BatchSubmissionRow[];
    return rows.map((row) => ({ ...mapBatchSubmission(row), items: this.listItems(row.id) }));
  }

  countFailedOlderThan(cutoff: Date): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM batch_submissions
         WHERE status IN ('failed', 'partial')
           AND datetime(created_at) < datetime(?)`
      )
      .get(cutoff.toISOString()) as { count: number };
    return row.count;
  }

  deleteFailedOlderThan(cutoff: Date): number {
    const rows = this.db
      .prepare(
        `SELECT id
         FROM batch_submissions
         WHERE status IN ('failed', 'partial')
           AND datetime(created_at) < datetime(?)`
      )
      .all(cutoff.toISOString()) as Array<{ id: number }>;
    if (rows.length === 0) return 0;

    const deleteItems = this.db.prepare("DELETE FROM batch_submission_items WHERE batch_id = ?");
    const deleteBatch = this.db.prepare("DELETE FROM batch_submissions WHERE id = ?");
    for (const row of rows) {
      deleteItems.run(row.id);
      deleteBatch.run(row.id);
    }
    return rows.length;
  }

  getWithItems(batchId: number): BatchSubmissionWithItems | null {
    const batch = this.getById(batchId);
    return batch ? { ...batch, items: this.listItems(batch.id) } : null;
  }

  private getById(batchId: number): BatchSubmission | null {
    const row = this.db.prepare("SELECT * FROM batch_submissions WHERE id = ?").get(batchId) as BatchSubmissionRow | undefined;
    return row ? mapBatchSubmission(row) : null;
  }

  private listItems(batchId: number): BatchSubmissionItem[] {
    const rows = this.db
      .prepare("SELECT * FROM batch_submission_items WHERE batch_id = ? ORDER BY id ASC")
      .all(batchId) as BatchSubmissionItemRow[];
    return rows.map(mapBatchSubmissionItem);
  }

  private getItemById(id: number): BatchSubmissionItem | null {
    const row = this.db.prepare("SELECT * FROM batch_submission_items WHERE id = ?").get(id) as BatchSubmissionItemRow | undefined;
    return row ? mapBatchSubmissionItem(row) : null;
  }
}

function mapBatchSubmission(row: BatchSubmissionRow): BatchSubmission {
  return {
    id: row.id,
    createdByUserId: row.created_by_user_id,
    projectName: row.project_name,
    status: row.status,
    totalCount: row.total_count,
    successCount: row.success_count,
    failedCount: row.failed_count,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    finishedAt: row.finished_at
  };
}

function mapBatchSubmissionItem(row: BatchSubmissionItemRow): BatchSubmissionItem {
  return {
    id: row.id,
    batchId: row.batch_id,
    fileName: row.file_name,
    approvalId: row.approval_id,
    status: row.status,
    errorMessage: row.error_message,
    placementState: row.placement_state,
    createdAt: row.created_at
  };
}
