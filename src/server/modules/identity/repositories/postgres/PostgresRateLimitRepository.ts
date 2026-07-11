import type { QueryResultRow } from "pg";
import type { QueryExecutor } from "../../../../platform/database/queryExecutor.ts";
import type { IncrementRateLimitInput, RateLimitRepository, SecurityRateLimitBucket, SecurityRateLimitBucketType } from "../rateLimitRepository.ts";

type RateLimitRow = QueryResultRow & {
  bucket_type: SecurityRateLimitBucketType;
  bucket_key: Buffer;
  window_started_at: Date;
  attempt_count: number;
  blocked_until: Date | null;
  updated_at: Date;
};

const RATE_LIMIT_COLUMNS = "bucket_type, bucket_key, window_started_at, attempt_count, blocked_until, updated_at";

function mapBucket(row: RateLimitRow): SecurityRateLimitBucket {
  return {
    bucketType: row.bucket_type,
    bucketKey: Buffer.from(row.bucket_key),
    windowStartedAt: row.window_started_at,
    attemptCount: row.attempt_count,
    blockedUntil: row.blocked_until,
    blocked: row.blocked_until !== null && row.blocked_until > row.updated_at,
    updatedAt: row.updated_at
  };
}

export class PostgresRateLimitRepository implements RateLimitRepository {
  constructor(private readonly executor: QueryExecutor) {}

  async increment(input: IncrementRateLimitInput) {
    const result = await this.executor.query<RateLimitRow>(
      `WITH times AS (SELECT clock_timestamp() AS now)
       INSERT INTO platform.security_rate_limit_buckets AS bucket
         (bucket_type, bucket_key, window_started_at, attempt_count, blocked_until, updated_at)
       SELECT $1, $2, now, 1,
         CASE WHEN 1 >= $4 THEN now + ($5 * interval '1 second') ELSE NULL END,
         now
       FROM times
       ON CONFLICT (bucket_type, bucket_key) DO UPDATE SET
         window_started_at = CASE
           WHEN bucket.blocked_until > GREATEST(EXCLUDED.updated_at, bucket.updated_at) THEN bucket.window_started_at
           WHEN bucket.window_started_at + ($3 * interval '1 second') <= GREATEST(EXCLUDED.updated_at, bucket.updated_at)
             THEN GREATEST(EXCLUDED.updated_at, bucket.updated_at)
           ELSE bucket.window_started_at
         END,
         attempt_count = CASE
           WHEN bucket.blocked_until > GREATEST(EXCLUDED.updated_at, bucket.updated_at) THEN bucket.attempt_count + 1
           WHEN bucket.window_started_at + ($3 * interval '1 second') <= GREATEST(EXCLUDED.updated_at, bucket.updated_at) THEN 1
           ELSE bucket.attempt_count + 1
         END,
         blocked_until = CASE
           WHEN bucket.blocked_until > GREATEST(EXCLUDED.updated_at, bucket.updated_at)
             THEN GREATEST(bucket.blocked_until, GREATEST(EXCLUDED.updated_at, bucket.updated_at) + ($5 * interval '1 second'))
           WHEN bucket.window_started_at + ($3 * interval '1 second') <= GREATEST(EXCLUDED.updated_at, bucket.updated_at)
             THEN CASE WHEN 1 >= $4
               THEN GREATEST(EXCLUDED.updated_at, bucket.updated_at) + ($5 * interval '1 second') ELSE NULL END
           WHEN bucket.attempt_count + 1 >= $4
             THEN GREATEST(EXCLUDED.updated_at, bucket.updated_at) + ($5 * interval '1 second')
           ELSE NULL
         END,
         updated_at = GREATEST(EXCLUDED.updated_at, bucket.updated_at)
       RETURNING ${RATE_LIMIT_COLUMNS}`,
      [input.bucketType, Buffer.from(input.bucketKey), input.windowSeconds, input.limit, input.blockSeconds]
    );
    return mapBucket(result.rows[0]!);
  }
}
