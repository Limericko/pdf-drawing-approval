import { describe, expect, it, vi } from "vitest";
import { createPlatformTestDatabase } from "./postgresHarness.ts";

const localEnv = {
  PDF_APPROVAL_PLATFORM_TEST_ADMIN_DATABASE_URL: "postgresql://postgres:secret@127.0.0.1:55432/postgres",
  PDF_APPROVAL_PLATFORM_TEST_DATABASE_URL: "postgresql://platform_migration:secret@127.0.0.1:55432/pdf_approval_platform",
  PDF_APPROVAL_PLATFORM_MIGRATION_DATABASE_URL:
    "postgresql://platform_migration:secret@127.0.0.1:55432/pdf_approval_platform",
  PDF_APPROVAL_PLATFORM_WEB_DATABASE_URL: "postgresql://platform_web:secret@127.0.0.1:55432/pdf_approval_platform",
  PDF_APPROVAL_PLATFORM_WORKER_DATABASE_URL: "postgresql://platform_worker:secret@127.0.0.1:55432/pdf_approval_platform",
  PDF_APPROVAL_PLATFORM_BOOTSTRAP_DATABASE_URL:
    "postgresql://platform_bootstrap:secret@127.0.0.1:55432/pdf_approval_platform"
};

type FakePool = {
  query: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
};

function pool(query: FakePool["query"] = vi.fn(async () => ({ rows: [] }))): FakePool {
  return { query, end: vi.fn(async () => undefined) };
}

describe("postgresHarness", () => {
  it("rejects a remote admin database before constructing a Pool", async () => {
    const poolFactory = vi.fn();

    await expect(
      createPlatformTestDatabase(
        { ...localEnv, PDF_APPROVAL_PLATFORM_TEST_ADMIN_DATABASE_URL: "postgresql://postgres:secret@db.example/postgres" },
        { poolFactory }
      )
    ).rejects.toThrow("PLATFORM_TEST_ADMIN_MUST_BE_LOCAL");
    expect(poolFactory).not.toHaveBeenCalled();
  });

  it("parses every role URL before creating the database", async () => {
    const poolFactory = vi.fn();

    await expect(
      createPlatformTestDatabase({ ...localEnv, PDF_APPROVAL_PLATFORM_WEB_DATABASE_URL: "not-a-url" }, { poolFactory })
    ).rejects.toThrow("PLATFORM_TEST_DATABASE_URL_INVALID:PDF_APPROVAL_PLATFORM_WEB_DATABASE_URL");
    expect(poolFactory).not.toHaveBeenCalled();
  });

  it("drops the database and closes the admin Pool when setup fails after CREATE DATABASE", async () => {
    const admin = pool(
      vi.fn(async (sql: string) => {
        if (sql.startsWith("GRANT CONNECT")) throw new Error("grant failed");
        return { rows: [] };
      })
    );

    await expect(createPlatformTestDatabase(localEnv, { poolFactory: () => admin as never })).rejects.toThrow(
      "grant failed"
    );
    expect(admin.query.mock.calls.some(([sql]) => String(sql).startsWith("DROP DATABASE"))).toBe(true);
    expect(admin.end).toHaveBeenCalledOnce();
  });

  it("reports cleanup failures, keeps the database name, and retries a failed DROP", async () => {
    let dropAttempts = 0;
    const firstAdmin = pool(
      vi.fn(async (sql: string) => {
        if (sql.startsWith("DROP DATABASE")) {
          dropAttempts += 1;
          throw new Error("drop failed");
        }
        return { rows: [] };
      })
    );
    const rolePool = pool();
    rolePool.end.mockRejectedValueOnce(new Error("role close failed"));
    const retryAdmin = pool(
      vi.fn(async (sql: string) => {
        if (sql.startsWith("DROP DATABASE")) dropAttempts += 1;
        return { rows: [] };
      })
    );
    const poolFactory = vi.fn()
      .mockReturnValueOnce(firstAdmin)
      .mockReturnValueOnce(rolePool)
      .mockReturnValueOnce(retryAdmin);
    const database = await createPlatformTestDatabase(localEnv, { poolFactory });
    database.createPool("web");

    await expect(database.dispose()).rejects.toThrow(database.databaseName);
    expect(firstAdmin.end).toHaveBeenCalledOnce();
    expect(dropAttempts).toBe(1);

    await expect(database.dispose()).resolves.toBeUndefined();
    await expect(database.dispose()).resolves.toBeUndefined();
    expect(retryAdmin.end).toHaveBeenCalledOnce();
    expect(dropAttempts).toBe(2);
  });

  it("retries role and admin Pool closure after DROP has already succeeded", async () => {
    const admin = pool();
    admin.end.mockRejectedValueOnce(new Error("admin close failed")).mockResolvedValueOnce(undefined);
    const rolePool = pool();
    rolePool.end.mockRejectedValueOnce(new Error("role close failed")).mockResolvedValueOnce(undefined);
    const poolFactory = vi.fn().mockReturnValueOnce(admin).mockReturnValueOnce(rolePool);
    const database = await createPlatformTestDatabase(localEnv, { poolFactory });
    database.createPool("web");

    await expect(database.dispose()).rejects.toThrow(database.databaseName);
    expect(admin.query.mock.calls.filter(([sql]) => String(sql).startsWith("DROP DATABASE"))).toHaveLength(1);
    expect(rolePool.end).toHaveBeenCalledTimes(1);
    expect(admin.end).toHaveBeenCalledTimes(1);

    await expect(database.dispose()).resolves.toBeUndefined();
    await expect(database.dispose()).resolves.toBeUndefined();
    expect(admin.query.mock.calls.filter(([sql]) => String(sql).startsWith("DROP DATABASE"))).toHaveLength(1);
    expect(rolePool.end).toHaveBeenCalledTimes(2);
    expect(admin.end).toHaveBeenCalledTimes(2);
  });
});
