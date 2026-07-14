import { createHash } from "node:crypto";
import type { QueryResultRow } from "pg";
import { v7 as uuidV7 } from "uuid";
import { recordPrintArchiveRequestSchema, type RecordPrintArchiveRequest } from "../../../shared/contracts/business.ts";
import { uuidV7Schema } from "../../../shared/contracts/common.ts";
import type { PlatformPool } from "../../platform/database/pool.ts";
import type { QueryExecutor } from "../../platform/database/queryExecutor.ts";
import { withTransaction } from "../../platform/database/transaction.ts";
import { PostgresAuditRepository } from "../identity/repositories/postgres/PostgresAuditRepository.ts";

type PrintRow = QueryResultRow & { id: string; project_id: string; approval_case_id: string; actor_user_id: string;
  object_id: string | null; printer_name: string | null; status: "archived" | "failed";
  error_code: string | null; created_at: Date; client_request_hash?: Buffer };

export class PrintArchiveServiceError extends Error {
  constructor(readonly code: "PRINT_ARCHIVE_INPUT_INVALID" | "PRINT_ARCHIVE_FORBIDDEN" |
    "PRINT_ARCHIVE_NOT_FOUND" | "PRINT_ARCHIVE_OBJECT_INVALID" | "PRINT_ARCHIVE_IDEMPOTENCY_CONFLICT" |
    "PRINT_ARCHIVE_DEPENDENCY_UNAVAILABLE", options?: ErrorOptions) {
    super(code, options);
    this.name = "PrintArchiveServiceError";
  }
}

export function createPrintArchiveService(options: { readonly pool: PlatformPool }) {
  if (!options?.pool) throw new Error("PRINT_ARCHIVE_POOL_REQUIRED");
  return Object.freeze({
    async record(input: { projectId: string; approvalId: string; actorUserId: string; requestId: string;
      result: RecordPrintArchiveRequest }) {
      const projectId = ownId(input?.projectId);
      const approvalId = ownId(input?.approvalId);
      const actorUserId = ownId(input?.actorUserId);
      const requestId = ownRequestId(input?.requestId);
      const parsed = recordPrintArchiveRequestSchema.safeParse(input?.result);
      if (!parsed.success) throw invalid();
      try {
        return await withTransaction(options.pool, async (transaction) => {
          await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
            [parsed.data.idempotencyKey]);
          const payloadHash = hash(parsed.data);
          const retry = await transaction.query<PrintRow>(
            `SELECT ${COLUMNS},client_request_hash FROM platform.print_archive_events WHERE client_request_id=$1`,
            [parsed.data.idempotencyKey]
          );
          if (retry.rows[0]) {
            if (!retry.rows[0].client_request_hash?.equals(payloadHash) || retry.rows[0].project_id !== projectId ||
                retry.rows[0].approval_case_id !== approvalId || retry.rows[0].actor_user_id !== actorUserId) {
              throw new PrintArchiveServiceError("PRINT_ARCHIVE_IDEMPOTENCY_CONFLICT");
            }
            return map(retry.rows[0]);
          }
          const access = await transaction.query<{ role: string; requires_signature: boolean; original_object_id: string }>(
            `SELECT membership.role,approval.requires_signature,revision.original_object_id
             FROM platform.project_members membership
             INNER JOIN platform.users actor ON actor.id=membership.user_id AND actor.status='active'
             INNER JOIN platform.approval_cases approval ON approval.project_id=membership.project_id
               AND approval.id=$3 AND approval.status='approved'
             INNER JOIN platform.drawing_revisions revision ON revision.id=approval.revision_id
             WHERE membership.project_id=$1 AND membership.user_id=$2 AND membership.status='active'`,
            [projectId, actorUserId, approvalId]
          );
          const source = access.rows[0];
          if (!source) throw new PrintArchiveServiceError("PRINT_ARCHIVE_NOT_FOUND");
          if (!["designer", "manager"].includes(source.role)) {
            throw new PrintArchiveServiceError("PRINT_ARCHIVE_FORBIDDEN");
          }
          if (parsed.data.status === "archived") {
            const valid = source.requires_signature
              ? await readySignedObject(transaction, approvalId, parsed.data.objectId!)
              : parsed.data.objectId === source.original_object_id ||
                await readySignedObject(transaction, approvalId, parsed.data.objectId!);
            if (!valid) throw new PrintArchiveServiceError("PRINT_ARCHIVE_OBJECT_INVALID");
          }
          const created = await transaction.query<PrintRow>(
            `INSERT INTO platform.print_archive_events
              (id,project_id,approval_case_id,actor_user_id,object_id,printer_name,status,error_code,
               client_request_id,client_request_hash)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${COLUMNS}`,
            [uuidV7(), projectId, approvalId, actorUserId, parsed.data.objectId, parsed.data.printerName,
              parsed.data.status, parsed.data.errorCode, parsed.data.idempotencyKey, payloadHash]
          );
          await new PostgresAuditRepository(transaction).appendOnly({ actorUserId, actorType: "user",
            action: `print_archive.${parsed.data.status}`, targetType: "approval_case", targetId: approvalId,
            requestId, result: parsed.data.status === "archived" ? "success" : "failure",
            metadata: { projectId, approvalId, newStatus: parsed.data.status } });
          return map(created.rows[0]!);
        });
      } catch (error) { throw owned(error); }
    },

    async list(input: { projectId: string; approvalId: string; actorUserId: string }) {
      const projectId = ownId(input?.projectId); const approvalId = ownId(input?.approvalId);
      const actorUserId = ownId(input?.actorUserId);
      try {
        const access = await options.pool.query(
          `SELECT 1 FROM platform.project_members WHERE project_id=$1 AND user_id=$2 AND status='active'`,
          [projectId, actorUserId]
        );
        if (!access.rows[0]) throw new PrintArchiveServiceError("PRINT_ARCHIVE_NOT_FOUND");
        const rows = await options.pool.query<PrintRow>(
          `SELECT ${COLUMNS} FROM platform.print_archive_events
           WHERE project_id=$1 AND approval_case_id=$2 ORDER BY created_at DESC,id DESC`, [projectId, approvalId]
        );
        return { items: rows.rows.map(map) };
      } catch (error) { throw owned(error); }
    }
  });
}

async function readySignedObject(executor: QueryExecutor, approvalId: string, objectId: string) {
  const result = await executor.query<{ ready: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM platform.render_artifacts
      WHERE approval_case_id=$1 AND kind='signed_pdf' AND status='ready' AND object_id=$2) AS ready`,
    [approvalId, objectId]
  );
  return result.rows[0]?.ready === true;
}
const COLUMNS = `id,project_id,approval_case_id,actor_user_id,object_id,printer_name,status,error_code,created_at`;
function map(row: PrintRow) { return { id: row.id, projectId: row.project_id, approvalCaseId: row.approval_case_id,
  actorUserId: row.actor_user_id, objectId: row.object_id, printerName: row.printer_name, status: row.status,
  errorCode: row.error_code, createdAt: new Date(row.created_at) }; }
function hash(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest(); }
function ownId(value: unknown) { const parsed = uuidV7Schema.safeParse(value); if (!parsed.success) throw invalid(); return parsed.data; }
function ownRequestId(value: unknown) { if (typeof value !== "string" || !value || value !== value.trim() ||
  value.length > 128 || /[\r\n\0]/.test(value)) throw invalid(); return value; }
function owned(error: unknown) { return error instanceof PrintArchiveServiceError ? error :
  new PrintArchiveServiceError("PRINT_ARCHIVE_DEPENDENCY_UNAVAILABLE", { cause: error }); }
function invalid() { return new PrintArchiveServiceError("PRINT_ARCHIVE_INPUT_INVALID"); }
