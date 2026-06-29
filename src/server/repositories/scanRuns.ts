import type { DatabaseConnection } from "../db.ts";

export type ScanRunStatus = "running" | "completed" | "failed";

export type ScanRun = {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  status: ScanRunStatus;
  processedCount: number;
  missingCount: number;
  invalidCount: number;
  errorMessage: string | null;
  triggeredBy: string;
};

type ScanRunRow = {
  id: number;
  started_at: string;
  finished_at: string | null;
  status: ScanRunStatus;
  processed_count: number;
  missing_count: number;
  invalid_count: number;
  error_message: string | null;
  triggered_by: string;
};

export class ScanRunRepository {
  constructor(private readonly db: DatabaseConnection) {}

  start(triggeredBy: string): ScanRun {
    const result = this.db.prepare("INSERT INTO scan_runs (status, triggered_by) VALUES ('running', ?)").run(triggeredBy);
    return this.getById(Number(result.lastInsertRowid))!;
  }

  complete(
    id: number,
    counts: { processedCount?: number; missingCount?: number; invalidCount?: number }
  ): ScanRun {
    this.db
      .prepare(
        `UPDATE scan_runs
         SET status = 'completed',
             finished_at = @finishedAt,
             processed_count = @processedCount,
             missing_count = @missingCount,
             invalid_count = @invalidCount,
             error_message = NULL
         WHERE id = @id`
      )
      .run({
        id,
        finishedAt: new Date().toISOString(),
        processedCount: counts.processedCount ?? 0,
        missingCount: counts.missingCount ?? 0,
        invalidCount: counts.invalidCount ?? 0
      });
    return this.getById(id)!;
  }

  fail(id: number, errorMessage: string): ScanRun {
    this.db
      .prepare(
        `UPDATE scan_runs
         SET status = 'failed',
             finished_at = @finishedAt,
             error_message = @errorMessage
         WHERE id = @id`
      )
      .run({ id, finishedAt: new Date().toISOString(), errorMessage });
    return this.getById(id)!;
  }

  getById(id: number): ScanRun | null {
    const row = this.db.prepare("SELECT * FROM scan_runs WHERE id = ?").get(id) as ScanRunRow | undefined;
    return row ? mapScanRun(row) : null;
  }

  listRecent(limit = 20): ScanRun[] {
    const rows = this.db.prepare("SELECT * FROM scan_runs ORDER BY started_at DESC, id DESC LIMIT ?").all(limit) as ScanRunRow[];
    return rows.map(mapScanRun);
  }
}

function mapScanRun(row: ScanRunRow): ScanRun {
  return {
    id: row.id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    processedCount: row.processed_count,
    missingCount: row.missing_count,
    invalidCount: row.invalid_count,
    errorMessage: row.error_message,
    triggeredBy: row.triggered_by
  };
}
