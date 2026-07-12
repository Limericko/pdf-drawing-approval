import { EventEmitter } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
      const server = await startPlatformWebServer({
        env: platformEnv(database.urls.web, storageRoot), host: "127.0.0.1", port: 0
      });

      await request(server).get("/health/live").expect(200, { ok: true });
      await request(server).get("/health/ready").expect(200);
      await close(server);
      await close(server);
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
