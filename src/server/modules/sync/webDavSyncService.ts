import { createHash } from "node:crypto";
import type { QueryResultRow } from "pg";
import { v7 as uuidv7 } from "uuid";
import {
  createWebDavConnectionRequestSchema,
  createWebDavMappingRequestSchema,
  retryWebDavSyncRequestSchema,
  resolveWebDavConflictRequestSchema,
  testWebDavConnectionRequestSchema,
  triggerWebDavScanRequestSchema,
  updateWebDavConnectionRequestSchema,
  updateWebDavMappingRequestSchema,
  webDavConflictListQuerySchema,
  webDavSyncItemListQuerySchema,
  type CreateWebDavConnectionRequest,
  type CreateWebDavMappingRequest,
  type ResolveWebDavConflictRequest,
  type UpdateWebDavConnectionRequest,
  type UpdateWebDavMappingRequest
} from "../../../shared/contracts/webdav.ts";
import { uuidV7Schema } from "../../../shared/contracts/common.ts";
import type { PlatformPool } from "../../platform/database/pool.ts";
import type { QueryExecutor } from "../../platform/database/queryExecutor.ts";
import { withTransaction } from "../../platform/database/transaction.ts";
import type { OutboxPublisher } from "../../platform/jobs/outboxPublisher.ts";
import { PostgresAuditRepository } from "../identity/repositories/postgres/PostgresAuditRepository.ts";

type ConnectionRow = QueryResultRow & {
  id: string; name: string; endpoint_url: string; credential_ref: string; credential_available: boolean;
  status: "active" | "disabled" | "error"; capabilities: Record<string, unknown>;
  last_checked_at: Date | null; last_error_code: string | null; version: number;
  created_at: Date; updated_at: Date;
};
type MappingRow = QueryResultRow & {
  id: string; connection_id: string; project_id: string; project_name: string; incoming_path: string;
  outgoing_path: string; publish_variant: "original" | "review" | "signed"; status: "active" | "disabled";
  scan_interval_seconds: number; next_scan_at: Date; last_scan_at: Date | null; last_success_at: Date | null;
  version: number; created_at: Date; updated_at: Date;
};
type ConflictRow = QueryResultRow & {
  id: string; project_id: string; mapping_id: string; sync_item_id: string; direction: "inbound" | "outbound";
  remote_path: string; remote_etag: string | null; remote_size_bytes: string | number | null;
  remote_modified_at: Date | null; remote_sha256: Buffer | null; cloud_revision_id: string | null;
  cloud_object_id: string | null; cloud_size_bytes: string | number | null; cloud_sha256: Buffer | null;
  status: "open" | "resolved"; resolution: "import_as_new_version" | "publish_cloud_as_renamed" | "keep_remote" | null;
  resolution_reason: string | null; renamed_remote_path: string | null; resolved_by_user_id: string | null;
  resolved_at: Date | null; version: number; created_at: Date; updated_at: Date;
};
type SyncItemRow = QueryResultRow & {
  id: string; mapping_id: string; project_id: string; direction: "inbound" | "outbound"; remote_path: string;
  remote_etag: string | null; remote_size_bytes: string | number | null; remote_modified_at: Date | null;
  remote_sha256: Buffer | null; storage_object_id: string | null; revision_id: string | null;
  status: "discovered" | "downloading" | "validating" | "imported" | "pending_upload" | "uploading" |
    "verifying" | "succeeded" | "conflict" | "remote_missing" | "failed" | "skipped";
  attempt_count: number; last_error_code: string | null; version: number; completed_at: Date | null;
  created_at: Date; updated_at: Date;
};

export class WebDavSyncServiceError extends Error {
  constructor(readonly code: "WEBDAV_SYNC_INPUT_INVALID" | "WEBDAV_SYNC_FORBIDDEN" |
    "WEBDAV_SYNC_NOT_FOUND" | "WEBDAV_SYNC_STATE_CONFLICT" | "WEBDAV_SYNC_IDEMPOTENCY_CONFLICT" |
    "WEBDAV_SYNC_PATH_OVERLAP" | "WEBDAV_SYNC_ENDPOINT_FORBIDDEN" | "WEBDAV_SYNC_DEPENDENCY_UNAVAILABLE",
  options?: ErrorOptions) {
    super(code, options);
    this.name = "WebDavSyncServiceError";
  }
}

export function createWebDavSyncService(options: {
  readonly pool: PlatformPool;
  readonly publisher: OutboxPublisher;
  readonly allowEndpoint: (url: URL) => boolean;
  readonly createId?: () => string;
  readonly clock?: () => Date;
}) {
  if (!options?.pool || !options.publisher || typeof options.allowEndpoint !== "function") throw dependency();
  const createId = options.createId ?? uuidv7;
  const clock = options.clock ?? (() => new Date());

  return Object.freeze({
    async listConnections(input: { actorUserId: string }) {
      try {
        await requireAdmin(options.pool, ownId(input?.actorUserId));
        const rows = await options.pool.query<ConnectionRow>(`${connectionSelect()} ORDER BY updated_at DESC,id DESC`);
        return { items: rows.rows.map(mapConnection) };
      } catch (error) { throw owned(error); }
    },

    async createConnection(input: { actorUserId: string; requestId: string; connectionId?: string;
      update: CreateWebDavConnectionRequest }) {
      const update = parse(createWebDavConnectionRequestSchema, input?.update);
      assertEndpoint(update.endpointUrl, options.allowEndpoint);
      const actorUserId = ownId(input?.actorUserId); const requestId = ownRequestId(input?.requestId);
      const targetId = input.connectionId === undefined ? ownCreatedId(createId()) : ownId(input.connectionId);
      return mutate(options.pool, { actorUserId, requestId, targetId, action: "webdav_connection_create",
        idempotencyKey: update.idempotencyKey, payload: update, createId }, async (transaction) => {
        await requireAdmin(transaction, actorUserId);
        await transaction.query(
          `INSERT INTO platform.webdav_connections
            (id,name,endpoint_url,credential_ref,status,created_by_user_id,created_at,updated_at)
           VALUES($1,$2,$3,$4,'active',$5,$6,$6)`,
          [targetId, update.name, update.endpointUrl, update.credentialRef, actorUserId, ownDate(clock())]
        );
        await audit(transaction, { actorUserId, requestId }, "webdav.connection.created", "webdav_connection",
          targetId, { reason: update.reason, connectionId: targetId });
        return true;
      }, async (executor, id) => mapConnection(await oneConnection(executor, id)));
    },

    async updateConnection(input: { actorUserId: string; connectionId: string; requestId: string;
      update: UpdateWebDavConnectionRequest }) {
      const update = parse(updateWebDavConnectionRequestSchema, input?.update);
      assertEndpoint(update.endpointUrl, options.allowEndpoint);
      const actorUserId = ownId(input?.actorUserId); const requestId = ownRequestId(input?.requestId);
      const targetId = ownId(input?.connectionId);
      return mutate(options.pool, { actorUserId, requestId, targetId, action: "webdav_connection_update",
        idempotencyKey: update.idempotencyKey, payload: update, createId }, async (transaction) => {
        await requireAdmin(transaction, actorUserId);
        const result = await transaction.query(
          `UPDATE platform.webdav_connections SET name=$2,endpoint_url=$3,credential_ref=$4,status=$5,
            credential_available=false,last_checked_at=NULL,last_error_code=NULL,version=version+1,updated_at=$6
           WHERE id=$1 AND version=$7`,
          [targetId, update.name, update.endpointUrl, update.credentialRef, update.status, ownDate(clock()), update.version]
        );
        if (result.rowCount !== 1) await distinguishConnection(transaction, targetId);
        await audit(transaction, { actorUserId, requestId }, "webdav.connection.updated", "webdav_connection",
          targetId, { reason: update.reason, connectionId: targetId, newStatus: update.status });
        return true;
      }, async (executor, id) => mapConnection(await oneConnection(executor, id)));
    },

    async testConnection(input: { actorUserId: string; connectionId: string; requestId: string;
      update: { reason: string } }) {
      const update = parse(testWebDavConnectionRequestSchema, input?.update);
      const actorUserId = ownId(input?.actorUserId); const connectionId = ownId(input?.connectionId);
      const requestId = ownRequestId(input?.requestId);
      try {
        return await withTransaction(options.pool, async (transaction) => {
          await requireAdmin(transaction, actorUserId); await oneConnection(transaction, connectionId, true);
          await options.publisher.publishIdempotent(transaction, { eventType: "webdav.connection.test", payloadVersion: 1,
            payload: { connectionId } }, `webdav-connection-test:${requestId}`);
          await audit(transaction, { actorUserId, requestId }, "webdav.connection.test.requested", "webdav_connection",
            connectionId, { reason: update.reason, connectionId });
          return mapConnection(await oneConnection(transaction, connectionId));
        });
      } catch (error) { throw owned(error); }
    },

    async listMappings(input: { actorUserId: string; projectId?: string }) {
      const actorUserId = ownId(input?.actorUserId); const projectId = input.projectId ? ownId(input.projectId) : null;
      try {
        await requireAdmin(options.pool, actorUserId);
        const rows = await options.pool.query<MappingRow>(`${mappingSelect()}
          WHERE ($1::uuid IS NULL OR mapping.project_id=$1) ORDER BY mapping.updated_at DESC,mapping.id DESC`, [projectId]);
        return { items: rows.rows.map(mapMapping) };
      } catch (error) { throw owned(error); }
    },

    async createMapping(input: { actorUserId: string; requestId: string; mappingId?: string;
      update: CreateWebDavMappingRequest }) {
      const update = parse(createWebDavMappingRequestSchema, input?.update);
      const actorUserId = ownId(input?.actorUserId); const requestId = ownRequestId(input?.requestId);
      const targetId = input.mappingId === undefined ? ownCreatedId(createId()) : ownId(input.mappingId);
      return mutate(options.pool, { actorUserId, requestId, targetId, action: "webdav_mapping_create",
        idempotencyKey: update.idempotencyKey, payload: update, createId }, async (transaction) => {
        await requireAdmin(transaction, actorUserId);
        await requireConnectionAndProject(transaction, update.connectionId, update.projectId);
        await assertNoPathOverlap(transaction, update.connectionId, update.incomingPath, update.outgoingPath);
        const at = ownDate(clock());
        await transaction.query(
          `INSERT INTO platform.webdav_directory_mappings
            (id,connection_id,project_id,incoming_path,outgoing_path,publish_variant,status,scan_interval_seconds,
              next_scan_at,created_by_user_id,created_at,updated_at)
           VALUES($1,$2,$3,$4,$5,$6,'active',$7,$8,$9,$8,$8)`,
          [targetId, update.connectionId, update.projectId, update.incomingPath, update.outgoingPath,
            update.publishVariant, update.scanIntervalSeconds, at, actorUserId]
        );
        await audit(transaction, { actorUserId, requestId }, "webdav.mapping.created", "webdav_mapping", targetId,
          { reason: update.reason, connectionId: update.connectionId, mappingId: targetId, projectId: update.projectId });
        return true;
      }, async (executor, id) => mapMapping(await oneMapping(executor, id)));
    },

    async updateMapping(input: { actorUserId: string; mappingId: string; requestId: string;
      update: UpdateWebDavMappingRequest }) {
      const update = parse(updateWebDavMappingRequestSchema, input?.update);
      const actorUserId = ownId(input?.actorUserId); const requestId = ownRequestId(input?.requestId);
      const targetId = ownId(input?.mappingId);
      return mutate(options.pool, { actorUserId, requestId, targetId, action: "webdav_mapping_update",
        idempotencyKey: update.idempotencyKey, payload: update, createId }, async (transaction) => {
        await requireAdmin(transaction, actorUserId);
        const current = await oneMapping(transaction, targetId, true);
        await assertNoPathOverlap(transaction, current.connection_id, update.incomingPath, update.outgoingPath, targetId);
        const result = await transaction.query(
          `UPDATE platform.webdav_directory_mappings SET incoming_path=$2,outgoing_path=$3,publish_variant=$4,
            scan_interval_seconds=$5,status=$6,next_scan_at=LEAST(next_scan_at,$7),version=version+1,updated_at=$7
           WHERE id=$1 AND version=$8`,
          [targetId, update.incomingPath, update.outgoingPath, update.publishVariant,
            update.scanIntervalSeconds, update.status, ownDate(clock()), update.version]
        );
        if (result.rowCount !== 1) await distinguishMapping(transaction, targetId);
        await audit(transaction, { actorUserId, requestId }, "webdav.mapping.updated", "webdav_mapping", targetId,
          { reason: update.reason, connectionId: current.connection_id, mappingId: targetId,
            projectId: current.project_id, newStatus: update.status });
        return true;
      }, async (executor, id) => mapMapping(await oneMapping(executor, id)));
    },

    async triggerScan(input: { actorUserId: string; requestId: string;
      update: { mappingId: string; reason: string; idempotencyKey: string } }) {
      const update = parse(triggerWebDavScanRequestSchema, input?.update);
      const actorUserId = ownId(input?.actorUserId); const requestId = ownRequestId(input?.requestId);
      try {
        return await withTransaction(options.pool, async (transaction) => {
          await requireAdmin(transaction, actorUserId); const mapping = await oneMapping(transaction, update.mappingId, true);
          await options.publisher.publishIdempotent(transaction, { eventType: "webdav.mapping.scan", payloadVersion: 1,
            payload: { mappingId: update.mappingId } }, update.idempotencyKey);
          await audit(transaction, { actorUserId, requestId }, "webdav.mapping.scan.requested", "webdav_mapping",
            update.mappingId, { reason: update.reason, connectionId: mapping.connection_id,
              mappingId: update.mappingId, projectId: mapping.project_id });
          return mapMapping(mapping);
        });
      } catch (error) { throw owned(error); }
    },

    async listSyncItems(input: { actorUserId: string; page?: number; pageSize?: number; projectId?: string;
      mappingId?: string; direction?: "inbound" | "outbound"; status?: SyncItemRow["status"] }) {
      const parsed = parse(webDavSyncItemListQuerySchema, compact(input));
      const actorUserId = ownId(input?.actorUserId);
      try {
        await requireAdmin(options.pool, actorUserId);
        const filters = [parsed.projectId ?? null, parsed.mappingId ?? null, parsed.direction ?? null, parsed.status ?? null];
        const count = await options.pool.query<{ total: number }>(
          `SELECT count(*)::int AS total FROM platform.webdav_sync_items item
           WHERE ($1::uuid IS NULL OR item.project_id=$1) AND ($2::uuid IS NULL OR item.mapping_id=$2)
             AND ($3::text IS NULL OR item.direction=$3) AND ($4::text IS NULL OR item.status=$4)`, filters
        );
        const rows = await options.pool.query<SyncItemRow>(`${syncItemSelect()}
          WHERE ($1::uuid IS NULL OR item.project_id=$1) AND ($2::uuid IS NULL OR item.mapping_id=$2)
            AND ($3::text IS NULL OR item.direction=$3) AND ($4::text IS NULL OR item.status=$4)
          ORDER BY item.updated_at DESC,item.id DESC LIMIT $5 OFFSET $6`,
        [...filters, parsed.pageSize, (parsed.page - 1) * parsed.pageSize]);
        const total = count.rows[0]?.total ?? 0;
        return { items: rows.rows.map(mapSyncItem), page: { page: parsed.page, pageSize: parsed.pageSize,
          total, pageCount: Math.ceil(total / parsed.pageSize) } };
      } catch (error) { throw owned(error); }
    },

    async retrySyncItem(input: { actorUserId: string; syncItemId: string; requestId: string;
      update: { reason: string; idempotencyKey: string } }) {
      const update = parse(retryWebDavSyncRequestSchema, input?.update);
      const actorUserId = ownId(input?.actorUserId); const requestId = ownRequestId(input?.requestId);
      const targetId = ownId(input?.syncItemId);
      return mutate(options.pool, { actorUserId, requestId, targetId, action: "webdav_sync_retry",
        idempotencyKey: update.idempotencyKey, payload: update, createId }, async (transaction) => {
        await requireAdmin(transaction, actorUserId);
        const item = await oneSyncItem(transaction, targetId, true);
        if (item.status !== "failed" && item.status !== "remote_missing") throw stateConflict();
        const nextStatus = item.direction === "inbound" ? "discovered" : "pending_upload";
        const at = ownDate(clock());
        await transaction.query(
          `UPDATE platform.webdav_sync_items SET status=$2,last_error_code=NULL,completed_at=NULL,
            version=version+1,updated_at=$3 WHERE id=$1`, [targetId, nextStatus, at]
        );
        await options.publisher.publishIdempotent(transaction, { eventType: "webdav.sync.retry", payloadVersion: 1,
          payload: { syncItemId: targetId } }, `webdav-sync-retry:${targetId}:${item.version}`);
        await audit(transaction, { actorUserId, requestId }, "webdav.sync.retry.requested", "webdav_sync_item",
          targetId, { reason: update.reason, mappingId: item.mapping_id, projectId: item.project_id,
            remotePath: item.remote_path });
        return true;
      }, async (executor, id) => mapSyncItem(await oneSyncItem(executor, id)));
    },

    async listConflicts(input: { actorUserId: string; page?: number; pageSize?: number; projectId?: string;
      status?: "open" | "resolved" }) {
      const parsed = parse(webDavConflictListQuerySchema, compact(input));
      const actorUserId = ownId(input?.actorUserId);
      try {
        await requireAdmin(options.pool, actorUserId);
        const filters = [parsed.projectId ?? null, parsed.status ?? null];
        const count = await options.pool.query<{ total: number }>(
          `SELECT count(*)::int AS total FROM platform.webdav_sync_conflicts conflict
           WHERE ($1::uuid IS NULL OR conflict.project_id=$1) AND ($2::text IS NULL OR conflict.status=$2)`, filters
        );
        const rows = await options.pool.query<ConflictRow>(`${conflictSelect("conflict")}
          WHERE ($1::uuid IS NULL OR conflict.project_id=$1) AND ($2::text IS NULL OR conflict.status=$2)
          ORDER BY conflict.created_at DESC,conflict.id DESC LIMIT $3 OFFSET $4`,
        [...filters, parsed.pageSize, (parsed.page - 1) * parsed.pageSize]);
        const total = count.rows[0]?.total ?? 0;
        return { items: rows.rows.map(mapConflict), page: { page: parsed.page, pageSize: parsed.pageSize,
          total, pageCount: Math.ceil(total / parsed.pageSize) } };
      } catch (error) { throw owned(error); }
    },

    async getSummary(input: { actorUserId: string }) {
      const actorUserId = ownId(input?.actorUserId);
      try {
        await requireAdmin(options.pool, actorUserId);
        const result = await options.pool.query<{
          active_connections: number; error_connections: number; active_mappings: number; due_mappings: number;
          pending_items: number; failed_items: number; remote_missing_items: number; open_conflicts: number;
          last_successful_sync_at: Date | null;
        }>(`SELECT
          (SELECT count(*)::int FROM platform.webdav_connections WHERE status='active') AS active_connections,
          (SELECT count(*)::int FROM platform.webdav_connections WHERE status='error') AS error_connections,
          (SELECT count(*)::int FROM platform.webdav_directory_mappings WHERE status='active') AS active_mappings,
          (SELECT count(*)::int FROM platform.webdav_directory_mappings
            WHERE status='active' AND next_scan_at<=clock_timestamp()) AS due_mappings,
          (SELECT count(*)::int FROM platform.webdav_sync_items
            WHERE status IN ('discovered','downloading','validating','pending_upload','uploading','verifying')) AS pending_items,
          (SELECT count(*)::int FROM platform.webdav_sync_items WHERE status='failed') AS failed_items,
          (SELECT count(*)::int FROM platform.webdav_sync_items WHERE status='remote_missing') AS remote_missing_items,
          (SELECT count(*)::int FROM platform.webdav_sync_conflicts WHERE status='open') AS open_conflicts,
          (SELECT max(completed_at) FROM platform.webdav_sync_items WHERE status IN ('imported','succeeded'))
            AS last_successful_sync_at`);
        const row = result.rows[0];
        if (!row) throw dependency();
        return { connections: { active: row.active_connections, error: row.error_connections },
          mappings: { active: row.active_mappings, due: row.due_mappings },
          items: { pending: row.pending_items, failed: row.failed_items, remoteMissing: row.remote_missing_items },
          openConflicts: row.open_conflicts, lastSuccessfulSyncAt: row.last_successful_sync_at };
      } catch (error) { throw owned(error); }
    },

    async resolveConflict(input: { actorUserId: string; conflictId: string; requestId: string;
      update: ResolveWebDavConflictRequest }) {
      const update = parse(resolveWebDavConflictRequestSchema, input?.update);
      const actorUserId = ownId(input?.actorUserId); const requestId = ownRequestId(input?.requestId);
      const targetId = ownId(input?.conflictId);
      return mutate(options.pool, { actorUserId, requestId, targetId, action: "webdav_conflict_resolve",
        idempotencyKey: update.idempotencyKey, payload: update, createId }, async (transaction) => {
        await requireAdmin(transaction, actorUserId);
        const conflict = await oneConflict(transaction, targetId, true);
        if (conflict.status !== "open" || conflict.version !== update.version) throw stateConflict();
        const at = ownDate(clock());
        await transaction.query(
          `UPDATE platform.webdav_sync_conflicts SET status='resolved',resolution=$2,resolution_reason=$3,
            renamed_remote_path=$4,resolved_by_user_id=$5,resolved_at=$6,version=version+1,updated_at=$6 WHERE id=$1`,
          [targetId, update.resolution, update.reason, update.renamedRemotePath, actorUserId, at]
        );
        if (update.resolution === "keep_remote") {
          await transaction.query(
            `UPDATE platform.webdav_sync_items SET status='skipped',completed_at=$2,last_error_code=NULL,
              version=version+1,updated_at=$2 WHERE id=$1`, [conflict.sync_item_id, at]
          );
        } else {
          const status = update.resolution === "import_as_new_version" ? "discovered" : "pending_upload";
          await transaction.query(
            `UPDATE platform.webdav_sync_items SET status=$2,completed_at=NULL,last_error_code=NULL,
              version=version+1,updated_at=$3 WHERE id=$1`, [conflict.sync_item_id, status, at]
          );
          await options.publisher.publishIdempotent(transaction, { eventType: "webdav.conflict.resolve", payloadVersion: 1,
            payload: { conflictId: targetId, resolution: update.resolution,
              ...(update.renamedRemotePath ? { renamedRemotePath: update.renamedRemotePath } : {}) } },
          `webdav-conflict-resolution:${targetId}:${update.version}`);
        }
        await audit(transaction, { actorUserId, requestId }, "webdav.conflict.resolved", "webdav_conflict", targetId,
          { reason: update.reason, conflictId: targetId, mappingId: conflict.mapping_id,
            projectId: conflict.project_id, remotePath: conflict.remote_path, resolution: update.resolution });
        return true;
      }, async (executor, id) => mapConflict(await oneConflict(executor, id)));
    }
  });
}

async function mutate<T>(pool: PlatformPool, input: { actorUserId: string; requestId: string; targetId: string;
  action: string; idempotencyKey: string; payload: unknown; createId: () => string },
operation: (transaction: QueryExecutor) => Promise<boolean>,
load: (executor: QueryExecutor, targetId: string) => Promise<T>) {
  try {
    return await withTransaction(pool, async (transaction) => {
      await requireAdmin(transaction, input.actorUserId);
      await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [input.idempotencyKey]);
      const payloadHash = hash(input.payload);
      const retry = await transaction.query<{ actor_user_id: string; action: string; target_id: string; payload_hash: Buffer }>(
        `SELECT actor_user_id,action,target_id,payload_hash FROM platform.admin_mutation_requests
         WHERE client_request_id=$1`, [input.idempotencyKey]
      );
      if (retry.rows[0]) {
        if (retry.rows[0].actor_user_id !== input.actorUserId || retry.rows[0].action !== input.action ||
            !retry.rows[0].payload_hash.equals(payloadHash)) throw idempotencyConflict();
        return load(transaction, retry.rows[0].target_id);
      }
      const changed = await operation(transaction);
      await transaction.query(
        `INSERT INTO platform.admin_mutation_requests
          (id,actor_user_id,action,target_id,client_request_id,payload_hash,result_changed)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [ownCreatedId(input.createId()), input.actorUserId, input.action, input.targetId,
          input.idempotencyKey, payloadHash, changed]
      );
      return load(transaction, input.targetId);
    });
  } catch (error) { throw owned(error); }
}

async function requireAdmin(executor: QueryExecutor, userId: string) {
  const result = await executor.query<{ allowed: boolean }>(
    "SELECT EXISTS(SELECT 1 FROM platform.users WHERE id=$1 AND platform_role='admin' AND status='active') AS allowed", [userId]
  );
  if (!result.rows[0]?.allowed) throw forbidden();
}
async function requireConnectionAndProject(executor: QueryExecutor, connectionId: string, projectId: string) {
  const result = await executor.query<{ connection: boolean; project: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM platform.webdav_connections WHERE id=$1) AS connection,
      EXISTS(SELECT 1 FROM platform.projects WHERE id=$2) AS project`, [connectionId, projectId]
  );
  if (!result.rows[0]?.connection || !result.rows[0]?.project) throw notFound();
}

async function assertNoPathOverlap(executor: QueryExecutor, connectionId: string, incoming: string, outgoing: string,
  excludeId?: string) {
  if (pathsOverlap(incoming, outgoing)) throw pathOverlap();
  const rows = await executor.query<{ incoming_path: string; outgoing_path: string }>(
    `SELECT incoming_path,outgoing_path FROM platform.webdav_directory_mappings
     WHERE connection_id=$1 AND status='active' AND ($2::uuid IS NULL OR id<>$2) FOR UPDATE`,
    [connectionId, excludeId ?? null]
  );
  for (const row of rows.rows) {
    if ([row.incoming_path, row.outgoing_path].some((path) => pathsOverlap(incoming, path) || pathsOverlap(outgoing, path))) {
      throw pathOverlap();
    }
  }
}
function pathsOverlap(left: string, right: string) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function connectionSelect() { return `SELECT id,name,endpoint_url,credential_ref,credential_available,status,capabilities,
  last_checked_at,last_error_code,version,created_at,updated_at FROM platform.webdav_connections`; }
async function oneConnection(executor: QueryExecutor, id: string, lock = false) {
  const result = await executor.query<ConnectionRow>(`${connectionSelect()} WHERE id=$1${lock ? " FOR UPDATE" : ""}`, [id]);
  if (!result.rows[0]) throw notFound(); return result.rows[0];
}
function mappingSelect() { return `SELECT mapping.id,mapping.connection_id,mapping.project_id,project.name AS project_name,
  mapping.incoming_path,mapping.outgoing_path,mapping.publish_variant,mapping.status,mapping.scan_interval_seconds,
  mapping.next_scan_at,mapping.last_scan_at,mapping.last_success_at,mapping.version,mapping.created_at,mapping.updated_at
  FROM platform.webdav_directory_mappings mapping JOIN platform.projects project ON project.id=mapping.project_id`; }
async function oneMapping(executor: QueryExecutor, id: string, lock = false) {
  const result = await executor.query<MappingRow>(`${mappingSelect()} WHERE mapping.id=$1${lock ? " FOR UPDATE OF mapping" : ""}`, [id]);
  if (!result.rows[0]) throw notFound(); return result.rows[0];
}
function conflictSelect(alias?: string) { const prefix = alias ? `${alias}.` : ""; return `SELECT ${prefix}id,${prefix}project_id,
  ${prefix}mapping_id,${prefix}sync_item_id,${prefix}direction,${prefix}remote_path,${prefix}remote_etag,
  ${prefix}remote_size_bytes,${prefix}remote_modified_at,${prefix}remote_sha256,${prefix}cloud_revision_id,
  ${prefix}cloud_object_id,${prefix}cloud_size_bytes,${prefix}cloud_sha256,${prefix}status,${prefix}resolution,
  ${prefix}resolution_reason,${prefix}renamed_remote_path,${prefix}resolved_by_user_id,${prefix}resolved_at,
  ${prefix}version,${prefix}created_at,${prefix}updated_at FROM platform.webdav_sync_conflicts${alias ? ` ${alias}` : ""}`; }
async function oneConflict(executor: QueryExecutor, id: string, lock = false) {
  const result = await executor.query<ConflictRow>(`${conflictSelect()} WHERE id=$1${lock ? " FOR UPDATE" : ""}`, [id]);
  if (!result.rows[0]) throw notFound(); return result.rows[0];
}
function syncItemSelect() { return `SELECT item.id,item.mapping_id,item.project_id,item.direction,item.remote_path,
  item.remote_etag,item.remote_size_bytes,item.remote_modified_at,item.remote_sha256,item.storage_object_id,item.revision_id,
  item.status,item.attempt_count,item.last_error_code,item.version,item.completed_at,item.created_at,item.updated_at
  FROM platform.webdav_sync_items item`; }
async function oneSyncItem(executor: QueryExecutor, id: string, lock = false) {
  const result = await executor.query<SyncItemRow>(`${syncItemSelect()} WHERE item.id=$1${lock ? " FOR UPDATE OF item" : ""}`, [id]);
  if (!result.rows[0]) throw notFound(); return result.rows[0];
}

function mapConnection(row: ConnectionRow) {
  const capabilities = row.capabilities ?? {};
  return { id: row.id, name: row.name, endpointUrl: row.endpoint_url, credentialRef: row.credential_ref,
    credentialAvailable: row.credential_available, status: row.status,
    capabilities: { class1: capabilities.class1 === true, move: capabilities.move === true,
      rangeDownload: capabilities.rangeDownload === true }, lastCheckedAt: row.last_checked_at,
    lastErrorCode: row.last_error_code, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at };
}
function mapMapping(row: MappingRow) { return { id: row.id, connectionId: row.connection_id, projectId: row.project_id,
  projectName: row.project_name, incomingPath: row.incoming_path, outgoingPath: row.outgoing_path,
  publishVariant: row.publish_variant, scanIntervalSeconds: row.scan_interval_seconds, status: row.status,
  nextScanAt: row.next_scan_at, lastScanAt: row.last_scan_at, lastSuccessAt: row.last_success_at,
  version: row.version, createdAt: row.created_at, updatedAt: row.updated_at }; }
function mapConflict(row: ConflictRow) { return { id: row.id, projectId: row.project_id, mappingId: row.mapping_id,
  syncItemId: row.sync_item_id, direction: row.direction, remotePath: row.remote_path, status: row.status,
  resolution: row.resolution, resolutionReason: row.resolution_reason, renamedRemotePath: row.renamed_remote_path,
  version: row.version, remote: { etag: row.remote_etag, sizeBytes: nullableNumber(row.remote_size_bytes),
    modifiedAt: row.remote_modified_at, sha256: row.remote_sha256?.toString("hex") ?? null },
  cloud: { revisionId: row.cloud_revision_id, objectId: row.cloud_object_id,
    sizeBytes: nullableNumber(row.cloud_size_bytes), sha256: row.cloud_sha256?.toString("hex") ?? null },
  createdAt: row.created_at, updatedAt: row.updated_at, resolvedAt: row.resolved_at,
  resolvedByUserId: row.resolved_by_user_id }; }
function mapSyncItem(row: SyncItemRow) { return { id: row.id, mappingId: row.mapping_id, projectId: row.project_id,
  direction: row.direction, remotePath: row.remote_path, remoteEtag: row.remote_etag,
  remoteSizeBytes: nullableNumber(row.remote_size_bytes), remoteModifiedAt: row.remote_modified_at,
  remoteSha256: row.remote_sha256?.toString("hex") ?? null, storageObjectId: row.storage_object_id,
  revisionId: row.revision_id, status: row.status, attemptCount: row.attempt_count,
  lastErrorCode: row.last_error_code, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
  completedAt: row.completed_at }; }

async function distinguishConnection(executor: QueryExecutor, id: string) {
  if (!(await executor.query("SELECT 1 FROM platform.webdav_connections WHERE id=$1", [id])).rowCount) throw notFound();
  throw stateConflict();
}
async function distinguishMapping(executor: QueryExecutor, id: string) {
  if (!(await executor.query("SELECT 1 FROM platform.webdav_directory_mappings WHERE id=$1", [id])).rowCount) throw notFound();
  throw stateConflict();
}
async function audit(executor: QueryExecutor, actor: { actorUserId: string; requestId: string }, action: string,
  targetType: string, targetId: string,
  metadata: Parameters<InstanceType<typeof PostgresAuditRepository>["appendOnly"]>[0]["metadata"]) {
  await new PostgresAuditRepository(executor).appendOnly({ actorUserId: actor.actorUserId, actorType: "user",
    action, targetType, targetId, requestId: actor.requestId, result: "success", metadata });
}
function assertEndpoint(value: string, allow: (url: URL) => boolean) {
  let url: URL; try { url = new URL(value); } catch { throw inputInvalid(); }
  if (!allow(url)) throw endpointForbidden();
}
function parse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown) {
  const parsed = schema.safeParse(value); if (!parsed.success) throw inputInvalid(); return parsed.data;
}
function compact(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => key !== "actorUserId" && item !== undefined));
}
function ownId(value: unknown) { const parsed = uuidV7Schema.safeParse(value); if (!parsed.success) throw inputInvalid(); return parsed.data; }
function ownCreatedId(value: string) { try { return ownId(value); } catch { throw dependency(); } }
function ownRequestId(value: unknown) { if (typeof value !== "string" || !value || value !== value.trim() ||
  value.length > 128 || /[\r\n\0]/.test(value)) throw inputInvalid(); return value; }
function ownDate(value: Date) { if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw dependency(); return new Date(value); }
function nullableNumber(value: string | number | null) { if (value === null) return null; const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw dependency(); return number; }
function hash(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest(); }
function owned(error: unknown) { return error instanceof WebDavSyncServiceError ? error : dependency(error); }
function inputInvalid() { return new WebDavSyncServiceError("WEBDAV_SYNC_INPUT_INVALID"); }
function forbidden() { return new WebDavSyncServiceError("WEBDAV_SYNC_FORBIDDEN"); }
function notFound() { return new WebDavSyncServiceError("WEBDAV_SYNC_NOT_FOUND"); }
function stateConflict() { return new WebDavSyncServiceError("WEBDAV_SYNC_STATE_CONFLICT"); }
function idempotencyConflict() { return new WebDavSyncServiceError("WEBDAV_SYNC_IDEMPOTENCY_CONFLICT"); }
function pathOverlap() { return new WebDavSyncServiceError("WEBDAV_SYNC_PATH_OVERLAP"); }
function endpointForbidden() { return new WebDavSyncServiceError("WEBDAV_SYNC_ENDPOINT_FORBIDDEN"); }
function dependency(cause?: unknown) { return new WebDavSyncServiceError("WEBDAV_SYNC_DEPENDENCY_UNAVAILABLE", { cause }); }
