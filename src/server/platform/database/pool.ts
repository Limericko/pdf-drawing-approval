import { Pool } from "pg";
import type { PlatformDatabaseConfig } from "../config/types.ts";

export const PLATFORM_POOL_IDLE_TIMEOUT_MS = 30_000;

export type PlatformTransactionTimeouts = Readonly<
  Pick<PlatformDatabaseConfig, "queryTimeoutMs" | "lockTimeoutMs" | "transactionTimeoutMs">
>;

export type PlatformPool = Pool & {
  readonly transactionTimeouts: PlatformTransactionTimeouts;
};

export function createPlatformPool(config: PlatformDatabaseConfig, applicationName: string): PlatformPool {
  const pool = new Pool({
    connectionString: config.connectionString,
    max: config.poolMax,
    connectionTimeoutMillis: config.connectTimeoutMs,
    idleTimeoutMillis: PLATFORM_POOL_IDLE_TIMEOUT_MS,
    application_name: applicationName
  }) as PlatformPool;

  Object.defineProperty(pool, "transactionTimeouts", {
    configurable: false,
    enumerable: true,
    value: Object.freeze({
      queryTimeoutMs: config.queryTimeoutMs,
      lockTimeoutMs: config.lockTimeoutMs,
      transactionTimeoutMs: config.transactionTimeoutMs
    }),
    writable: false
  });

  return pool;
}
