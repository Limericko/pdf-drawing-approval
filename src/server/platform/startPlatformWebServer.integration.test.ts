import { EventEmitter } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPlatformConfig } from "./config/loadPlatformConfig.ts";
import { runMigrations } from "./database/migrationRunner.ts";
import { withPlatformTestDatabase } from "./testing/postgresHarness.ts";
import { startPlatformWebServer } from "./startPlatformWebServer.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("startPlatformWebServer", () => {
  it("starts against the expected schema and closes HTTP, Pool, and Storage idempotently", async () => {
    await withPlatformTestDatabase(async (database) => {
      await runMigrations(database.createPool("migration"));
      const storageRoot = await temporaryDirectory("platform-web-storage-");
      const env = platformEnv(database.urls.web, storageRoot);
      env.PDF_APPROVAL_PUBLIC_BASE_URL = "http://127.0.0.1/nested/app";
      const server = await startPlatformWebServer({
        env, host: "127.0.0.1", port: 0
      });

      await request(server).get("/health").expect(200).expect((response) => {
        expect(response.body.basePath).toBe("/nested/app/");
        expect(JSON.stringify(response.body)).not.toContain("127.0.0.1");
      });
      await request(server).get("/health/live").expect(200, { ok: true });
      await request(server).get("/health/ready").expect(200);
      await close(server);
      await close(server);
    });
  });

  it("reports persisted worker and SMTP health as non-blocking advisories without exposing internals", async () => {
    await withPlatformTestDatabase(async (database) => {
      const migration = database.createPool("migration");
      await runMigrations(migration);
      await migration.query(
        `INSERT INTO platform.worker_heartbeats (worker_id, started_at, heartbeat_at, metadata)
         VALUES ('worker-secret-id', clock_timestamp(), clock_timestamp(),
           '{"state":"active","smtp":"unhealthy"}'::jsonb)`
      );
      const storageRoot = await temporaryDirectory("platform-web-advisory-");
      const server = await startPlatformWebServer({
        env: platformEnv(database.urls.web, storageRoot), host: "127.0.0.1", port: 0
      });
      try {
        const response = await request(server).get("/health/ready").expect(200);
        expect(response.body).toMatchObject({
          ok: true,
          advisories: { worker: "healthy", smtp: "unhealthy" }
        });
        expect(JSON.stringify(response.body)).not.toMatch(/error|secret|credential|worker-secret-id/i);
      } finally {
        await close(server);
      }
    });
  });

  it("keeps readiness available while stale worker and SMTP heartbeats are unhealthy", async () => {
    await withPlatformTestDatabase(async (database) => {
      const migration = database.createPool("migration");
      await runMigrations(migration);
      await migration.query(
        `INSERT INTO platform.worker_heartbeats (worker_id, started_at, heartbeat_at, metadata)
         VALUES ('stale-worker', clock_timestamp() - interval '4 minutes',
           clock_timestamp() - interval '3 minutes', '{"state":"active","smtp":"healthy"}'::jsonb)`
      );
      const storageRoot = await temporaryDirectory("platform-web-stale-advisory-");
      const server = await startPlatformWebServer({
        env: platformEnv(database.urls.web, storageRoot), host: "127.0.0.1", port: 0
      });
      try {
        const response = await request(server).get("/health/ready").expect(200);
        expect(response.body).toMatchObject({
          ok: true,
          advisories: { worker: "unhealthy", smtp: "unhealthy" }
        });
      } finally {
        await close(server);
      }
    });
  });

  it("rejects a missing/behind schema before creating storage and does not fall back to SQLite", async () => {
    await withPlatformTestDatabase(async (database) => {
      const storageRoot = path.join(await temporaryDirectory("platform-web-behind-"), "must-not-be-created");
      await expect(startPlatformWebServer({
        env: platformEnv(database.urls.web, storageRoot), host: "127.0.0.1", port: 0
      })).rejects.toMatchObject({ code: "SCHEMA_VERSION_METADATA_MISSING" });
      await expect(access(storageRoot)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("aggregates startup and cleanup failures without leaking dependency secrets", async () => {
    const pool = { query: vi.fn(), end: vi.fn(async () => { throw new Error("pool cleanup secret"); }) };
    await expect(startPlatformWebServer({
      env: {},
      dependencies: {
        loadConfig: () => ({ database: {} }) as never,
        createPool: () => pool as never,
        assertSchema: async () => { throw new Error("schema failure credential"); }
      }
    })).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as Error).message).toBe("PLATFORM_WEB_STARTUP_CLEANUP_FAILED");
      const aggregate = error as AggregateError;
      expect(JSON.stringify({
        message: aggregate.message,
        errors: aggregate.errors.map((entry) => entry instanceof Error ? entry.message : String(entry)),
        cause: aggregate.cause instanceof Error ? aggregate.cause.message : aggregate.cause
      })).not.toMatch(/secret|credential/);
      return true;
    });
  });

  it("rejects arbitrary uppercase dependency tokens across nested startup errors", async () => {
    const pool = { query: vi.fn(), end: vi.fn(async () => undefined) };
    const secretCode = Object.assign(new Error("internal endpoint"), { code: "AWS_SECRET_ACCESS_KEY" });
    const failure = new AggregateError([
      secretCode,
      new AggregateError([new Error("INTERNAL_TOKEN")], "PRIVATE_DATABASE_HOST")
    ], "AWS_SECRET_ACCESS_KEY", { cause: Object.assign(new Error("credential"), { code: "INTERNAL_TOKEN" }) });

    const observed = await startPlatformWebServer({
      env: {},
      dependencies: {
        loadConfig: () => ({ database: {} }) as never,
        createPool: () => pool as never,
        loadMigrations: async () => [],
        assertSchema: async () => { throw failure; }
      }
    }).then(() => undefined, (error: unknown) => observeError(error));

    expect(observed).toEqual({
      message: "PLATFORM_WEB_START_FAILED",
      errors: [
        { message: "PLATFORM_WEB_START_FAILED", code: "PLATFORM_WEB_START_FAILED" },
        { message: "PLATFORM_WEB_START_FAILED", errors: [
          { message: "PLATFORM_WEB_START_FAILED", code: "PLATFORM_WEB_START_FAILED" }
        ], cause: undefined }
      ],
      cause: { message: "PLATFORM_WEB_START_FAILED", code: "PLATFORM_WEB_START_FAILED" }
    });
    expect(JSON.stringify(observed)).not.toMatch(/AWS_SECRET_ACCESS_KEY|INTERNAL_TOKEN|PRIVATE_DATABASE_HOST|credential/i);
  });

  it("bounds a hanging schema startup gate and closes only the Pool", async () => {
    vi.useFakeTimers();
    let schemaAborted = false;
    const pool = { query: vi.fn(), end: vi.fn(() => schemaAborted
      ? Promise.resolve()
      : new Promise<void>(() => undefined)) };
    const createStorage = vi.fn();
    let outcome: unknown;
    try {
      void startPlatformWebServer({
        env: {},
        dependencies: {
          loadConfig: () => ({ database: {} }) as never,
          createPool: () => pool as never,
          loadMigrations: async () => [],
          assertSchema: (_pool, _migrations, gate) => new Promise<void>((_resolve, reject) => {
            gate?.signal.addEventListener("abort", () => {
              schemaAborted = true;
              reject(new Error("schema probe aborted"));
            }, { once: true });
          }),
          createStorage
        }
      }).then(() => { outcome = "started"; }, (error: unknown) => { outcome = error; });

      await vi.advanceTimersByTimeAsync(5_000);
      expect(outcome).toMatchObject({ code: "PLATFORM_STARTUP_SCHEMA_TIMEOUT" });
      expect(schemaAborted).toBe(true);
      expect(createStorage).not.toHaveBeenCalled();
      expect(pool.end).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a bounded pg query that releases the client before closing the Pool", async () => {
    vi.useFakeTimers();
    let queryReleased = false;
    const query = vi.fn((input: unknown) => {
      if (!input || typeof input !== "object" || !("query_timeout" in input)) {
        return new Promise<void>(() => undefined);
      }
      const queryTimeout = input.query_timeout;
      if (typeof queryTimeout !== "number") return new Promise<void>(() => undefined);
      return new Promise((_resolve, reject) => setTimeout(() => {
        queryReleased = true;
        reject(new Error("Query read timeout"));
      }, queryTimeout));
    });
    const pool = {
      query,
      end: vi.fn(() => queryReleased ? Promise.resolve() : new Promise<void>(() => undefined))
    };
    let outcome: unknown;
    try {
      void startPlatformWebServer({
        env: {},
        dependencies: {
          loadConfig: () => ({ database: {} }) as never,
          createPool: () => pool as never,
          loadMigrations: async () => []
        }
      }).then(() => { outcome = "started"; }, (error: unknown) => { outcome = error; });

      await vi.advanceTimersByTimeAsync(5_000);
      expect(outcome).toMatchObject({ code: "PLATFORM_STARTUP_SCHEMA_TIMEOUT" });
      expect(query).toHaveBeenCalledWith(expect.objectContaining({
        query_timeout: expect.any(Number)
      }));
      expect(queryReleased).toBe(true);
      expect(pool.end).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a hanging Storage startup gate and closes Storage and Pool once", async () => {
    vi.useFakeTimers();
    const pool = { query: vi.fn(), end: vi.fn(async () => undefined) };
    let storageAborted = false;
    const storage = {
      driver: "filesystem" as const,
      checkHealth: vi.fn((gate?: { signal?: AbortSignal }) => new Promise<void>((_resolve, reject) => {
        gate?.signal?.addEventListener("abort", () => {
          storageAborted = true;
          reject(new Error("storage probe aborted"));
        }, { once: true });
      })),
      destroy: vi.fn()
    };
    const createServices = vi.fn();
    const createApp = vi.fn();
    let outcome: unknown;
    try {
      void startPlatformWebServer({
        env: {},
        dependencies: {
          loadConfig: () => ({ database: {}, storage: {} }) as never,
          createPool: () => pool as never,
          loadMigrations: async () => [],
          assertSchema: async () => undefined,
          createStorage: () => storage as never,
          createServices,
          createApp
        }
      }).then(() => { outcome = "started"; }, (error: unknown) => { outcome = error; });

      await vi.advanceTimersByTimeAsync(5_000);
      expect(outcome).toMatchObject({ code: "PLATFORM_STARTUP_STORAGE_TIMEOUT" });
      expect(storageAborted).toBe(true);
      expect(storage.destroy).toHaveBeenCalledOnce();
      expect(pool.end).toHaveBeenCalledOnce();
      expect(createServices).not.toHaveBeenCalled();
      expect(createApp).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds an uncooperative cleanup after aborting a startup probe", async () => {
    vi.useFakeTimers();
    const pool = { query: vi.fn(), end: vi.fn(() => new Promise<void>(() => undefined)) };
    let outcome: unknown;
    try {
      void startPlatformWebServer({
        env: {},
        dependencies: {
          loadConfig: () => ({ database: {} }) as never,
          createPool: () => pool as never,
          loadMigrations: async () => [],
          assertSchema: (_pool, _migrations, gate) => new Promise<void>((_resolve, reject) => {
            gate?.signal.addEventListener("abort", () => reject(new Error("schema probe aborted")), { once: true });
          })
        }
      }).then(() => { outcome = "started"; }, (error: unknown) => { outcome = error; });

      await vi.advanceTimersByTimeAsync(6_000);
      expect(outcome).toBeInstanceOf(AggregateError);
      expect(observeError(outcome)).toMatchObject({
        message: "PLATFORM_WEB_STARTUP_CLEANUP_FAILED",
        errors: [
          { code: "PLATFORM_STARTUP_SCHEMA_TIMEOUT" },
          { errors: [{ code: "PLATFORM_POOL_CLOSE_TIMEOUT" }] }
        ]
      });
      expect(pool.end).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("force-closes a real hanging HTTP request before releasing Storage and Pool", async () => {
    const storageRoot = await temporaryDirectory("platform-web-hanging-request-");
    const pool = { query: vi.fn(), end: vi.fn(async () => undefined) };
    const storage = {
      driver: "filesystem" as const,
      checkHealth: vi.fn(async () => undefined),
      destroy: vi.fn()
    };
    let requestArrived!: () => void;
    const arrived = new Promise<void>((resolve) => { requestArrived = resolve; });
    const app = express();
    app.get("/hang", () => { requestArrived(); });
    const server = await startPlatformWebServer({
      env: {}, host: "127.0.0.1", port: 0,
      dependencies: {
        loadConfig: () => loadPlatformConfig(platformEnv("postgresql://local.invalid/test", storageRoot), "web"),
        createPool: () => pool as never,
        loadMigrations: async () => [],
        assertSchema: async () => undefined,
        createStorage: () => storage as never,
        createServices: () => ({}) as never,
        createApp: () => app
      }
    });
    const client = hangingRequest(server);
    try {
      await arrived;
      const forceIdle = vi.spyOn(server, "closeIdleConnections");
      const forceAll = vi.spyOn(server, "closeAllConnections");
      const outcome = await Promise.race([
        server.closeAsync().then(() => "closed", (error: unknown) => error),
        new Promise((resolve) => setTimeout(() => resolve("STILL_CLOSING_AFTER_DEADLINE"), 5_000))
      ]);

      expect(outcome).toBe("closed");
      expect(forceIdle).toHaveBeenCalled();
      expect(forceAll).toHaveBeenCalledOnce();
      expect(storage.destroy).toHaveBeenCalledOnce();
      expect(pool.end).toHaveBeenCalledOnce();
    } finally {
      client.destroy();
      server.closeAllConnections();
      await server.closeAsync().catch(() => undefined);
    }
  });

  it("lets a normal in-flight request drain before the force-close deadline", async () => {
    const storageRoot = await temporaryDirectory("platform-web-graceful-request-");
    const pool = { query: vi.fn(), end: vi.fn(async () => undefined) };
    const storage = {
      driver: "filesystem" as const,
      checkHealth: vi.fn(async () => undefined),
      destroy: vi.fn()
    };
    let requestArrived!: () => void;
    let releaseRequest!: () => void;
    const arrived = new Promise<void>((resolve) => { requestArrived = resolve; });
    const release = new Promise<void>((resolve) => { releaseRequest = resolve; });
    const app = express();
    app.get("/slow", async (_request, response) => {
      requestArrived();
      await release;
      response.status(200).json({ ok: true });
    });
    const server = await startPlatformWebServer({
      env: {}, host: "127.0.0.1", port: 0,
      dependencies: {
        loadConfig: () => loadPlatformConfig(platformEnv("postgresql://local.invalid/test", storageRoot), "web"),
        createPool: () => pool as never,
        loadMigrations: async () => [],
        assertSchema: async () => undefined,
        createStorage: () => storage as never,
        createServices: () => ({}) as never,
        createApp: () => app
      }
    });
    const forceAll = vi.spyOn(server, "closeAllConnections");
    const response = request(server).get("/slow");
    const responseOutcome = response.then((result) => result);
    await arrived;
    const closing = server.closeAsync();
    releaseRequest();

    await expect(responseOutcome).resolves.toMatchObject({ status: 200, body: { ok: true } });
    await expect(closing).resolves.toBeUndefined();
    expect(forceAll).not.toHaveBeenCalled();
    expect(storage.destroy).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("bounds an uncooperative HTTP close and force-close while cleaning resources once", async () => {
    vi.useFakeTimers();
    const storageRoot = await temporaryDirectory("platform-web-http-close-timeout-");
    const pool = { query: vi.fn(), end: vi.fn(async () => undefined) };
    const storage = {
      driver: "filesystem" as const,
      checkHealth: vi.fn(async () => undefined),
      destroy: vi.fn()
    };
    const originalClose = vi.fn(() => fakeServer);
    const closeIdleConnections = vi.fn(() => { throw new Error("idle force secret"); });
    const closeAllConnections = vi.fn(() => { throw new Error("all force credential"); });
    const fakeServer = Object.assign(new EventEmitter(), {
      listening: true,
      close: originalClose,
      closeIdleConnections,
      closeAllConnections
    });
    const app = { listen: vi.fn(() => {
      queueMicrotask(() => fakeServer.emit("listening"));
      return fakeServer;
    }) };
    try {
      const server = await startPlatformWebServer({
        env: {},
        dependencies: {
          loadConfig: () => loadPlatformConfig(platformEnv("postgresql://local.invalid/test", storageRoot), "web"),
          createPool: () => pool as never,
          loadMigrations: async () => [],
          assertSchema: async () => undefined,
          createStorage: () => storage as never,
          createServices: () => ({}) as never,
          createApp: () => app as never
        }
      });

      const first = server.closeAsync();
      const second = server.closeAsync();
      expect(second).toBe(first);
      let outcomes: PromiseSettledResult<void>[] | undefined;
      void Promise.allSettled([first, second]).then((result) => { outcomes = result; });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(outcomes).toBeDefined();
      if (!outcomes) throw new Error("HTTP_CLOSE_DID_NOT_SETTLE");
      for (const outcome of outcomes) {
        expect(outcome.status).toBe("rejected");
        if (outcome.status === "rejected") {
          expect(observeError(outcome.reason)).toMatchObject({ code: "PLATFORM_HTTP_CLOSE_TIMEOUT" });
          expect(JSON.stringify(observeError(outcome.reason))).not.toMatch(/secret|credential|password/i);
        }
      }
      expect(originalClose).toHaveBeenCalledOnce();
      expect(closeIdleConnections).toHaveBeenCalledOnce();
      expect(closeAllConnections).toHaveBeenCalledOnce();
      expect(storage.destroy).toHaveBeenCalledOnce();
      expect(pool.end).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("always releases resources and aggregates sanitized HTTP close failures idempotently", async () => {
    const storageRoot = await temporaryDirectory("platform-web-close-errors-");
    const pool = { query: vi.fn(), end: vi.fn(async () => { throw new Error("pool close secret"); }) };
    const storage = {
      driver: "filesystem" as const,
      checkHealth: vi.fn(async () => undefined),
      destroy: vi.fn(() => { throw new Error("storage close credential"); })
    };
    const originalClose = vi.fn((callback?: (error?: Error) => void) => {
      fakeServer.listening = false;
      callback?.(new Error("http close password"));
      return fakeServer;
    });
    const fakeServer = Object.assign(new EventEmitter(), {
      listening: true,
      close: originalClose
    });
    const app = { listen: vi.fn(() => {
      queueMicrotask(() => fakeServer.emit("listening"));
      return fakeServer;
    }) };
    const server = await startPlatformWebServer({
      env: {},
      dependencies: {
        loadConfig: () => loadPlatformConfig(platformEnv("postgresql://local.invalid/test", storageRoot), "web"),
        createPool: () => pool as never,
        loadMigrations: async () => [],
        assertSchema: async () => undefined,
        createStorage: () => storage as never,
        createServices: () => ({}) as never,
        createApp: () => app as never
      }
    });

    const first = await closeFailure(server);
    const second = await closeFailure(server);
    expect(originalClose).toHaveBeenCalledOnce();
    expect(storage.destroy).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledOnce();
    for (const failure of [first, second]) {
      expect(failure).toBeInstanceOf(AggregateError);
      const aggregate = failure as AggregateError;
      expect(aggregate.errors).toHaveLength(2);
      expect(JSON.stringify({ message: aggregate.message,
        errors: aggregate.errors.map((entry) => entry instanceof Error ? entry.message : String(entry)) }))
        .not.toMatch(/password|secret|credential/);
    }
  });
});

function platformEnv(connectionString: string, storageRoot: string): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    PDF_APPROVAL_PLATFORM_WEB_DATABASE_URL: connectionString,
    PDF_APPROVAL_STORAGE_DRIVER: "filesystem",
    PDF_APPROVAL_STORAGE_FILESYSTEM_ROOT: storageRoot,
    PDF_APPROVAL_PUBLIC_BASE_URL: "http://127.0.0.1",
    PDF_APPROVAL_COOKIE_SECURE: "false",
    PDF_APPROVAL_TOTP_KEYRING: "local-only-platform-web-totp",
    PDF_APPROVAL_INVITATION_HMAC_KEYRING: "local-only-platform-web-invitation",
    PDF_APPROVAL_RECOVERY_HMAC_KEYRING: "local-only-platform-web-recovery",
    PDF_APPROVAL_CSRF_HMAC_KEYRING: "local-only-platform-web-csrf"
  };
}

async function temporaryDirectory(prefix: string) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function close(server: Awaited<ReturnType<typeof startPlatformWebServer>>) {
  return new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function closeFailure(server: Awaited<ReturnType<typeof startPlatformWebServer>>) {
  try {
    await close(server);
    throw new Error("EXPECTED_CLOSE_FAILURE");
  } catch (error) {
    return error;
  }
}

function hangingRequest(server: Awaited<ReturnType<typeof startPlatformWebServer>>) {
  const address = server.address() as AddressInfo;
  const client = httpRequest({ host: "127.0.0.1", port: address.port, path: "/hang", method: "GET" });
  client.on("error", () => undefined);
  client.end();
  return client;
}

function observeError(error: unknown): unknown {
  if (!(error instanceof Error)) return String(error);
  return {
    message: error.message,
    ...(error instanceof AggregateError ? {
      errors: error.errors.map(observeError),
      cause: error.cause === undefined ? undefined : observeError(error.cause)
    } : {
      code: "code" in error ? error.code : undefined
    })
  };
}
