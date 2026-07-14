import type { QueryResultRow } from "pg";
import { v7 as uuidV7 } from "uuid";
import { setSignatureAssetRequestSchema, type SetSignatureAssetRequest } from "../../../shared/contracts/business.ts";
import { uuidV7Schema } from "../../../shared/contracts/common.ts";
import type { PlatformPool } from "../../platform/database/pool.ts";
import { withTransaction } from "../../platform/database/transaction.ts";
import { PostgresAuditRepository } from "../identity/repositories/postgres/PostgresAuditRepository.ts";

type AssetRow = QueryResultRow & { id: string; user_id: string; object_id: string;
  kind: "handwritten_png"; created_at: Date };

export class SignatureServiceError extends Error {
  constructor(readonly code: "SIGNATURE_INPUT_INVALID" | "SIGNATURE_USER_NOT_FOUND" |
    "SIGNATURE_OBJECT_NOT_READY" | "SIGNATURE_IDEMPOTENCY_CONFLICT" | "SIGNATURE_DEPENDENCY_UNAVAILABLE",
  options?: ErrorOptions) {
    super(code, options);
    this.name = "SignatureServiceError";
  }
}

export function createSignatureService(options: { readonly pool: PlatformPool }) {
  if (!options?.pool) throw new Error("SIGNATURE_SERVICE_POOL_REQUIRED");
  return Object.freeze({
    async getActive(input: { readonly actorUserId: string }) {
      const actorUserId = ownId(input?.actorUserId);
      try {
        const result = await options.pool.query<AssetRow>(
          `SELECT id,user_id,object_id,kind,created_at FROM platform.signature_assets
           WHERE user_id=$1 AND active=true`, [actorUserId]
        );
        return result.rows[0] ? mapAsset(result.rows[0]) : null;
      } catch (error) { throw owned(error); }
    },

    async setActive(input: { readonly actorUserId: string; readonly requestId: string;
      readonly update: SetSignatureAssetRequest }) {
      const actorUserId = ownId(input?.actorUserId);
      const requestId = ownRequestId(input?.requestId);
      const parsed = setSignatureAssetRequestSchema.safeParse(input?.update);
      if (!parsed.success) throw invalid();
      try {
        return await withTransaction(options.pool, async (transaction) => {
          await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
            [parsed.data.idempotencyKey]);
          const retry = await transaction.query<AssetRow & { client_request_id: string }>(
            `SELECT id,user_id,object_id,kind,created_at,client_request_id
             FROM platform.signature_assets WHERE client_request_id=$1`, [parsed.data.idempotencyKey]
          );
          if (retry.rows[0]) {
            if (retry.rows[0].user_id !== actorUserId || retry.rows[0].object_id !== parsed.data.objectId) {
              throw new SignatureServiceError("SIGNATURE_IDEMPOTENCY_CONFLICT");
            }
            return mapAsset(retry.rows[0]);
          }
          const source = await transaction.query<{ ready: boolean }>(
            `SELECT EXISTS (
               SELECT 1 FROM platform.storage_objects WHERE id=$1 AND status='ready' AND media_type='image/png'
             ) AND EXISTS (
               SELECT 1 FROM platform.users WHERE id=$2 AND status='active'
             ) AS ready`, [parsed.data.objectId, actorUserId]
          );
          if (!source.rows[0]?.ready) throw new SignatureServiceError("SIGNATURE_OBJECT_NOT_READY");
          await transaction.query(
            "UPDATE platform.signature_assets SET active=false WHERE user_id=$1 AND active=true", [actorUserId]
          );
          const created = await transaction.query<AssetRow>(
            `INSERT INTO platform.signature_assets (id,user_id,object_id,client_request_id)
             VALUES ($1,$2,$3,$4) RETURNING id,user_id,object_id,kind,created_at`,
            [uuidV7(), actorUserId, parsed.data.objectId, parsed.data.idempotencyKey]
          );
          await new PostgresAuditRepository(transaction).appendOnly({ actorUserId, actorType: "user",
            action: "signature.asset.replace", targetType: "signature_asset", targetId: created.rows[0]!.id,
            requestId, result: "success", metadata: {} });
          return mapAsset(created.rows[0]!);
        });
      } catch (error) { throw owned(error); }
    }
  });
}

function mapAsset(row: AssetRow) {
  return Object.freeze({ id: row.id, userId: row.user_id, objectId: row.object_id,
    kind: row.kind, createdAt: new Date(row.created_at) });
}

function ownId(value: unknown) {
  const parsed = uuidV7Schema.safeParse(value);
  if (!parsed.success) throw invalid();
  return parsed.data;
}

function ownRequestId(value: unknown) {
  if (typeof value !== "string" || value !== value.trim() || !value || value.length > 128 || /[\r\n\0]/.test(value)) {
    throw invalid();
  }
  return value;
}

function owned(error: unknown) {
  if (error instanceof SignatureServiceError) return error;
  return new SignatureServiceError("SIGNATURE_DEPENDENCY_UNAVAILABLE", { cause: error });
}

function invalid() { return new SignatureServiceError("SIGNATURE_INPUT_INVALID"); }
