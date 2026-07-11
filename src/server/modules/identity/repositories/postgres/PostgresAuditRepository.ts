import type { QueryResultRow } from "pg";
import type { QueryExecutor } from "../../../../platform/database/queryExecutor.ts";
import { createIdentityId } from "../../ids.ts";
import type {
  AppendAuditEventInput,
  AuditEvent,
  AuditMetadata,
  AuditMetadataKey,
  AuditRepository,
  AuditResult,
  ListAuditEventsInput
} from "../auditRepository.ts";

type AuditRow = QueryResultRow & {
  id: string; occurred_at: Date; actor_user_id: string | null; actor_type: string; action: string;
  target_type: string; target_id: string | null; request_id: string; result: AuditResult;
  metadata: Record<string, unknown>;
};

const AUDIT_COLUMNS = `id, occurred_at, actor_user_id, actor_type, action, target_type,
  target_id, request_id, result, metadata`;
const AUDIT_METADATA_KEYS = new Set<AuditMetadataKey>([
  "reason", "ipPrefix", "userAgent", "projectId", "documentId", "sessionId", "mfaMethod"
]);

function validateAndCopyMetadata(metadata: AuditMetadata): AuditMetadata {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("INVALID_AUDIT_METADATA");
  }
  const copy: Partial<Record<AuditMetadataKey, string | number | boolean | null>> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!AUDIT_METADATA_KEYS.has(key as AuditMetadataKey)) throw new Error("INVALID_AUDIT_METADATA_KEY");
    if (value !== null && !["string", "number", "boolean"].includes(typeof value)) {
      throw new Error("INVALID_AUDIT_METADATA_VALUE");
    }
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("INVALID_AUDIT_METADATA_VALUE");
    copy[key as AuditMetadataKey] = value as string | number | boolean | null;
  }
  return copy;
}

function mapAudit(row: AuditRow): AuditEvent {
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    actorUserId: row.actor_user_id,
    actorType: row.actor_type,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    requestId: row.request_id,
    result: row.result,
    metadata: validateAndCopyMetadata(row.metadata as AuditMetadata)
  };
}

export class PostgresAuditRepository implements AuditRepository {
  constructor(private readonly executor: QueryExecutor) {}

  async append(input: AppendAuditEventInput) {
    const metadata = validateAndCopyMetadata(input.metadata);
    const result = await this.executor.query<AuditRow>(
      `INSERT INTO platform.audit_events
         (id, actor_user_id, actor_type, action, target_type, target_id, request_id, result, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${AUDIT_COLUMNS}`,
      [createIdentityId(), input.actorUserId, input.actorType, input.action, input.targetType,
        input.targetId, input.requestId, input.result, metadata]
    );
    return mapAudit(result.rows[0]!);
  }

  async list(input: ListAuditEventsInput = {}) {
    const limit = auditLimit(input.limit);
    const conditions: string[] = [];
    const values: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      values.push(value);
      conditions.push(`${sql} $${values.length}`);
    };
    if (input.actorUserId !== undefined) add("actor_user_id =", input.actorUserId);
    if (input.requestId !== undefined) add("request_id =", input.requestId);
    if (input.targetType !== undefined) add("target_type =", input.targetType);
    if (input.targetId !== undefined) add("target_id =", input.targetId);
    if (input.beforeOccurredAt !== undefined) {
      add("occurred_at <", new Date(input.beforeOccurredAt.getTime()));
    }
    values.push(limit);
    const result = await this.executor.query<AuditRow>(
      `SELECT ${AUDIT_COLUMNS} FROM platform.audit_events
       ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY occurred_at DESC, id DESC LIMIT $${values.length}`,
      values
    );
    return result.rows.map(mapAudit);
  }
}

function auditLimit(value: number | undefined) {
  if (value === undefined) return 50;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("INVALID_AUDIT_LIMIT");
  return Math.min(100, value);
}
