import type { DatabaseConnection } from "../db.ts";

export type OperationLog = {
  id: number;
  actorUserId: number | null;
  actorUsername: string | null;
  action: string;
  targetType: string;
  targetId: number | null;
  message: string;
  metadata: unknown;
  createdAt: string;
};

type OperationLogRow = {
  id: number;
  actor_user_id: number | null;
  actor_username: string | null;
  action: string;
  target_type: string;
  target_id: number | null;
  message: string;
  metadata_json: string | null;
  created_at: string;
};

export class OperationLogRepository {
  constructor(private readonly db: DatabaseConnection) {}

  create(input: {
    actorUserId?: number | null;
    actorUsername?: string | null;
    action: string;
    targetType: string;
    targetId?: number | null;
    message: string;
    metadata?: unknown;
  }): OperationLog {
    const result = this.db
      .prepare(
        `INSERT INTO operation_logs (
          actor_user_id, actor_username, action, target_type, target_id, message, metadata_json
        ) VALUES (
          @actorUserId, @actorUsername, @action, @targetType, @targetId, @message, @metadataJson
        )`
      )
      .run({
        actorUserId: input.actorUserId ?? null,
        actorUsername: input.actorUsername ?? null,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId ?? null,
        message: input.message,
        metadataJson: input.metadata === undefined ? null : JSON.stringify(input.metadata)
      });

    return this.getById(Number(result.lastInsertRowid))!;
  }

  getById(id: number): OperationLog | null {
    const row = this.db.prepare("SELECT * FROM operation_logs WHERE id = ?").get(id) as OperationLogRow | undefined;
    return row ? mapOperationLog(row) : null;
  }

  listRecent(limit = 100): OperationLog[] {
    const rows = this.db
      .prepare("SELECT * FROM operation_logs ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(limit) as OperationLogRow[];
    return rows.map(mapOperationLog);
  }

  listForTarget(targetType: string, targetId: number): OperationLog[] {
    const rows = this.db
      .prepare("SELECT * FROM operation_logs WHERE target_type = ? AND target_id = ? ORDER BY created_at ASC, id ASC")
      .all(targetType, targetId) as OperationLogRow[];
    return rows.map(mapOperationLog);
  }
}

function mapOperationLog(row: OperationLogRow): OperationLog {
  return {
    id: row.id,
    actorUserId: row.actor_user_id,
    actorUsername: row.actor_username,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    message: row.message,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : null,
    createdAt: row.created_at
  };
}
