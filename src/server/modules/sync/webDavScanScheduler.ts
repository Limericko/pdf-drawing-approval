import type { QueryResultRow } from "pg";
import type { PlatformPool } from "../../platform/database/pool.ts";
import { withTransaction } from "../../platform/database/transaction.ts";
import type { OutboxPublisher } from "../../platform/jobs/outboxPublisher.ts";

type DueMappingRow = QueryResultRow & {
  id: string; next_scan_at: Date; scan_interval_seconds: number; effective_now: Date;
};

export class WebDavScanScheduler {
  constructor(private readonly options: {
    readonly pool: PlatformPool;
    readonly publisher: OutboxPublisher;
    readonly clock?: () => Date;
    readonly batchSize?: number;
  }) {
    if (!options?.pool || !options.publisher) throw new Error("WEBDAV_SCAN_SCHEDULER_OPTIONS_INVALID");
  }

  async runOnce(signal: AbortSignal) {
    signal.throwIfAborted();
    const clock = this.options.clock ?? (() => new Date());
    const now = clock();
    const batchSize = this.options.batchSize ?? 20;
    if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || !Number.isSafeInteger(batchSize) ||
        batchSize < 1 || batchSize > 100) throw new Error("WEBDAV_SCAN_SCHEDULER_OPTIONS_INVALID");
    return withTransaction(this.options.pool, async (transaction) => {
      const due = await transaction.query<DueMappingRow>(
        `SELECT mapping.id,mapping.next_scan_at,mapping.scan_interval_seconds,
                GREATEST($1::timestamptz,transaction_timestamp()) AS effective_now
         FROM platform.webdav_directory_mappings mapping
         INNER JOIN platform.webdav_connections connection ON connection.id=mapping.connection_id
         WHERE mapping.status='active' AND connection.status='active'
           AND mapping.next_scan_at<=GREATEST($1::timestamptz,transaction_timestamp())
         ORDER BY mapping.next_scan_at,mapping.id FOR UPDATE OF mapping SKIP LOCKED LIMIT $2`, [now, batchSize]
      );
      for (const mapping of due.rows) {
        signal.throwIfAborted();
        const effectiveNow = new Date(mapping.effective_now);
        const next = new Date(effectiveNow.getTime() + mapping.scan_interval_seconds * 1000);
        await transaction.query(
          "UPDATE platform.webdav_directory_mappings SET next_scan_at=$2,updated_at=$1 WHERE id=$3",
          [effectiveNow, next, mapping.id]
        );
        await this.options.publisher.publishIdempotent(transaction, {
          eventType: "webdav.mapping.scan", payloadVersion: 1, payload: { mappingId: mapping.id }
        }, `webdav-scheduled-scan:${mapping.id}:${mapping.next_scan_at.toISOString()}`);
      }
      return { scheduled: due.rows.length };
    });
  }
}
