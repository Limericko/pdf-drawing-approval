import { describe, expect, it } from "vitest";
import type { PlatformDatabaseConfig } from "../config/types.ts";
import { classifyDatabaseError } from "./databaseErrors.ts";
import { createPlatformPool, PLATFORM_POOL_IDLE_TIMEOUT_MS } from "./pool.ts";

const databaseConfig: PlatformDatabaseConfig = {
  connectionString: "postgresql://platform_web:test-password@127.0.0.1:55432/platform",
  poolMax: 7,
  connectTimeoutMs: 1_234,
  queryTimeoutMs: 2_345,
  lockTimeoutMs: 3_456,
  transactionTimeoutMs: 4_567
};

describe("createPlatformPool", () => {
  it("maps the shared database config and the explicit application name to pg Pool options", async () => {
    const pool = createPlatformPool(databaseConfig, "pdf-approval-web");

    try {
      expect(pool.options).toEqual(
        expect.objectContaining({
          connectionString: databaseConfig.connectionString,
          max: databaseConfig.poolMax,
          connectionTimeoutMillis: databaseConfig.connectTimeoutMs,
          idleTimeoutMillis: PLATFORM_POOL_IDLE_TIMEOUT_MS,
          application_name: "pdf-approval-web"
        })
      );
      expect(pool.transactionTimeouts).toEqual({
        queryTimeoutMs: databaseConfig.queryTimeoutMs,
        lockTimeoutMs: databaseConfig.lockTimeoutMs,
        transactionTimeoutMs: databaseConfig.transactionTimeoutMs
      });
      expect(Object.isFrozen(pool.transactionTimeouts)).toBe(true);
    } finally {
      await pool.end();
    }
  });

  it("uses an explicit named idle timeout because PlatformDatabaseConfig has no idle timeout field", () => {
    expect(PLATFORM_POOL_IDLE_TIMEOUT_MS).toBe(30_000);
  });
});

describe("classifyDatabaseError", () => {
  it.each([
    "08000",
    "08001",
    "08003",
    "08006",
    "57P01",
    "57P02",
    "57P03",
    "ECONNREFUSED",
    "ECONNRESET",
    "ECONNABORTED",
    "ETIMEDOUT",
    "EPIPE",
    "EAI_AGAIN",
    "ENETDOWN",
    "ENETUNREACH",
    "EHOSTUNREACH"
  ])("classifies the explicit connection code %s as retryable", (code) => {
    expect(classifyDatabaseError(Object.assign(new Error("database unavailable"), { code }))).toEqual({
      kind: "connection",
      transient: true,
      retryable: true
    });
  });

  it.each([
    ["40001", "serialization_failure"],
    ["40P01", "deadlock_detected"]
  ] as const)("classifies SQLSTATE %s as retryable %s", (code, kind) => {
    expect(classifyDatabaseError({ code })).toEqual({ kind, transient: true, retryable: true });
  });

  it("fails closed for unknown codes and does not inspect error messages", () => {
    expect(classifyDatabaseError({ code: "23505" })).toEqual({
      kind: "unknown",
      transient: false,
      retryable: false
    });
    expect(classifyDatabaseError(new Error("ECONNRESET 40001 deadlock_detected"))).toEqual({
      kind: "unknown",
      transient: false,
      retryable: false
    });
  });

  it.each(["08004", "08007", "08P01"])("does not retry the ambiguous connection-class code %s", (code) => {
    expect(classifyDatabaseError({ code })).toEqual({
      kind: "unknown",
      transient: false,
      retryable: false
    });
  });
});
