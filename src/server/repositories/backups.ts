import type { DatabaseConnection } from "../db.ts";

export type BackupRunStatus = "running" | "completed" | "failed";

export type BackupRun = {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  status: BackupRunStatus;
  backupPath: string | null;
  errorMessage: string | null;
  triggeredBy: string;
};

type BackupRunRow = {
  id: number;
  started_at: string;
  finished_at: string | null;
  status: BackupRunStatus;
  backup_path: string | null;
  error_message: string | null;
  triggered_by: string;
};

export class BackupRunRepository {
  constructor(private readonly db: DatabaseConnection) {}

  start(triggeredBy: string): BackupRun {
    const result = this.db.prepare("INSERT INTO backup_runs (status, triggered_by) VALUES ('running', ?)").run(triggeredBy);
    return this.getById(Number(result.lastInsertRowid))!;
  }

  complete(id: number, backupPath: string): BackupRun {
    this.db
      .prepare(
        `UPDATE backup_runs
         SET status = 'completed',
             finished_at = @finishedAt,
             backup_path = @backupPath,
             error_message = NULL
         WHERE id = @id`
      )
      .run({ id, finishedAt: new Date().toISOString(), backupPath });
    return this.getById(id)!;
  }

  fail(id: number, errorMessage: string): BackupRun {
    this.db
      .prepare(
        `UPDATE backup_runs
         SET status = 'failed',
             finished_at = @finishedAt,
             error_message = @errorMessage
         WHERE id = @id`
      )
      .run({ id, finishedAt: new Date().toISOString(), errorMessage });
    return this.getById(id)!;
  }

  getById(id: number): BackupRun | null {
    const row = this.db.prepare("SELECT * FROM backup_runs WHERE id = ?").get(id) as BackupRunRow | undefined;
    return row ? mapBackupRun(row) : null;
  }

  listRecent(limit = 20): BackupRun[] {
    const rows = this.db.prepare("SELECT * FROM backup_runs ORDER BY started_at DESC, id DESC LIMIT ?").all(limit) as BackupRunRow[];
    return rows.map(mapBackupRun);
  }
}

function mapBackupRun(row: BackupRunRow): BackupRun {
  return {
    id: row.id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    backupPath: row.backup_path,
    errorMessage: row.error_message,
    triggeredBy: row.triggered_by
  };
}
