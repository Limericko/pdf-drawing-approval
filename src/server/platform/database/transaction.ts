import type { QueryResult, QueryResultRow } from "pg";
import type { PlatformTransactionTimeouts } from "./pool.ts";
import type { QueryExecutor } from "./queryExecutor.ts";

type TransactionClient = {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
  release(error?: Error | boolean): void;
};

type TransactionPool = {
  readonly transactionTimeouts: PlatformTransactionTimeouts;
  connect(): Promise<TransactionClient>;
};

export async function withTransaction<T>(
  pool: TransactionPool,
  callback: (transaction: QueryExecutor) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  const transaction = bindQueryExecutor(client);
  let result!: T;
  let primaryError: unknown;
  let rollbackError: unknown;
  let releaseError: unknown;
  let releaseSignal: Error | true | undefined;
  let hasPrimaryError = false;
  let hasRollbackError = false;
  let hasReleaseError = false;

  try {
    await client.query("BEGIN");
    await setLocalTimeout(client, "statement_timeout", pool.transactionTimeouts.queryTimeoutMs);
    await setLocalTimeout(client, "lock_timeout", pool.transactionTimeouts.lockTimeoutMs);
    await setLocalTimeout(
      client,
      "idle_in_transaction_session_timeout",
      pool.transactionTimeouts.transactionTimeoutMs
    );
    result = await callback(transaction);
    await client.query("COMMIT");
  } catch (error) {
    hasPrimaryError = true;
    primaryError = error;
    try {
      await client.query("ROLLBACK");
    } catch (error) {
      hasRollbackError = true;
      rollbackError = error;
      releaseSignal = error instanceof Error ? error : true;
    }
  }

  try {
    if (releaseSignal === undefined) client.release();
    else client.release(releaseSignal);
  } catch (error) {
    hasReleaseError = true;
    releaseError = error;
  }

  if (hasPrimaryError) {
    const cleanupErrors = [
      ...(hasRollbackError ? [rollbackError] : []),
      ...(hasReleaseError ? [releaseError] : [])
    ];
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        "DATABASE_TRANSACTION_CLEANUP_FAILED",
        { cause: primaryError }
      );
    }
    throw primaryError;
  }
  if (hasReleaseError) throw releaseError;
  return result;
}

function bindQueryExecutor(client: TransactionClient): QueryExecutor {
  return {
    query<R extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]) {
      if (values === undefined) return client.query<R>(text);
      return client.query<R>(text, [...values]);
    }
  };
}

async function setLocalTimeout(client: TransactionClient, name: string, timeoutMs: number) {
  await client.query("SELECT set_config($1, $2, true)", [name, `${timeoutMs}ms`]);
}
