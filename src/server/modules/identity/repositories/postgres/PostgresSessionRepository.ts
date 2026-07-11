import type { QueryResultRow } from "pg";
import type { QueryExecutor } from "../../../../platform/database/queryExecutor.ts";
import { createIdentityId } from "../../ids.ts";
import type { CreateSessionInput, PlatformSession, SessionRepository } from "../sessionRepository.ts";

type SessionRow = QueryResultRow & {
  id: string; user_id: string; token_hash: Buffer; created_at: Date; absolute_expires_at: Date;
  idle_expires_at: Date; last_activity_at: Date; last_touch_at: Date; revoked_at: Date | null;
  client_summary: string | null;
};

const SESSION_COLUMNS = `id, user_id, token_hash, created_at, absolute_expires_at, idle_expires_at,
  last_activity_at, last_touch_at, revoked_at, client_summary`;

function mapSession(row: SessionRow): PlatformSession {
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: Buffer.from(row.token_hash),
    createdAt: row.created_at,
    absoluteExpiresAt: row.absolute_expires_at,
    idleExpiresAt: row.idle_expires_at,
    lastActivityAt: row.last_activity_at,
    lastTouchAt: row.last_touch_at,
    revokedAt: row.revoked_at,
    clientSummary: row.client_summary
  };
}

export class PostgresSessionRepository implements SessionRepository {
  constructor(private readonly executor: QueryExecutor) {}

  async create(input: CreateSessionInput) {
    const result = await this.executor.query<SessionRow>(
      `WITH times AS (SELECT clock_timestamp() AS now),
       expirations AS (
         SELECT now,
           now + ($4 * interval '1 second') AS absolute_expires_at,
           now + ($5 * interval '1 second') AS requested_idle_expires_at
         FROM times
       )
       INSERT INTO platform.sessions
         (id, user_id, token_hash, created_at, absolute_expires_at, idle_expires_at,
          last_activity_at, last_touch_at, client_summary)
       SELECT $1, $2, $3, now, absolute_expires_at,
         LEAST(requested_idle_expires_at, absolute_expires_at), now, now, $6
       FROM expirations
       RETURNING ${SESSION_COLUMNS}`,
      [createIdentityId(), input.userId, Buffer.from(input.tokenHash), input.absoluteLifetimeSeconds,
        input.idleLifetimeSeconds, input.clientSummary ?? null]
    );
    return mapSession(result.rows[0]!);
  }

  async findActiveByTokenHash(tokenHash: Buffer) {
    const result = await this.executor.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM platform.sessions
       WHERE token_hash = $1 AND revoked_at IS NULL
         AND absolute_expires_at > clock_timestamp() AND idle_expires_at > clock_timestamp()`,
      [Buffer.from(tokenHash)]
    );
    return result.rows[0] ? mapSession(result.rows[0]) : undefined;
  }

  async touch(id: string, idleLifetimeSeconds: number, minimumIntervalSeconds = 300) {
    const result = await this.executor.query<SessionRow>(
      `WITH times AS (SELECT clock_timestamp() AS now)
       UPDATE platform.sessions session
       SET last_activity_at = times.now,
           last_touch_at = times.now,
           idle_expires_at = LEAST(session.absolute_expires_at, times.now + ($2 * interval '1 second'))
       FROM times
       WHERE session.id = $1 AND session.revoked_at IS NULL
         AND session.absolute_expires_at > times.now AND session.idle_expires_at > times.now
         AND session.last_touch_at <= times.now - ($3 * interval '1 second')
       RETURNING ${SESSION_COLUMNS}`,
      [id, idleLifetimeSeconds, minimumIntervalSeconds]
    );
    return result.rows[0] ? mapSession(result.rows[0]) : undefined;
  }

  async revoke(id: string) {
    const result = await this.executor.query<SessionRow>(
      `UPDATE platform.sessions SET revoked_at = clock_timestamp()
       WHERE id = $1 AND revoked_at IS NULL
       RETURNING ${SESSION_COLUMNS}`,
      [id]
    );
    return result.rows[0] ? mapSession(result.rows[0]) : undefined;
  }

  async revokeAllForUser(userId: string) {
    const result = await this.executor.query(
      `UPDATE platform.sessions SET revoked_at = clock_timestamp()
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId]
    );
    return result.rowCount ?? 0;
  }
}
