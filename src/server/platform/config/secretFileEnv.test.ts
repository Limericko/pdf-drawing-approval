import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSecretFileEnvironment } from "./secretFileEnv.ts";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe("production secret file environment", () => {
  it("loads only target-owned secret fields and removes one conventional trailing newline", async () => {
    const root = await tempRoot();
    const database = await secret(root, "database", "postgresql://web:strong-password@db.example/platform\r\n");
    const ignoredWorker = await secret(root, "worker", "postgresql://worker:password@db.example/platform");
    const resolved = resolveSecretFileEnvironment({
      NODE_ENV: "production",
      PDF_APPROVAL_PLATFORM_WEB_DATABASE_URL_FILE: database,
      PDF_APPROVAL_PLATFORM_WORKER_DATABASE_URL_FILE: ignoredWorker
    }, "web");

    expect(resolved.PDF_APPROVAL_PLATFORM_WEB_DATABASE_URL)
      .toBe("postgresql://web:strong-password@db.example/platform");
    expect(resolved.PDF_APPROVAL_PLATFORM_WORKER_DATABASE_URL).toBeUndefined();
  });

  it("rejects a direct value combined with its file indirection", async () => {
    const root = await tempRoot();
    const file = await secret(root, "database", "postgresql://web:password@db.example/platform");
    expect(() => resolveSecretFileEnvironment({
      PDF_APPROVAL_PLATFORM_WEB_DATABASE_URL: "postgresql://other:password@db.example/platform",
      PDF_APPROVAL_PLATFORM_WEB_DATABASE_URL_FILE: file
    }, "web")).toThrow("PLATFORM_CONFIG_INVALID:PDF_APPROVAL_PLATFORM_WEB_DATABASE_URL_FILE");
  });

  it.each([
    ["relative path", async (_root: string) => "relative.secret"],
    ["missing path", async (root: string) => path.join(root, "missing")],
    ["directory", async (root: string) => { const target = path.join(root, "directory"); await mkdir(target); return target; }],
    ["empty file", async (root: string) => secret(root, "empty", "")],
    ["oversized file", async (root: string) => secret(root, "large", "x".repeat(64 * 1024 + 1))],
    ["NUL byte", async (root: string) => secret(root, "nul", Buffer.from([0x61, 0, 0x62]))],
    ["invalid UTF-8", async (root: string) => secret(root, "utf8", Buffer.from([0xc3, 0x28]))]
  ])("rejects a %s", async (_name, createPath) => {
    const root = await tempRoot();
    const file = await createPath(root);
    expect(() => resolveSecretFileEnvironment({
      PDF_APPROVAL_PLATFORM_MIGRATION_DATABASE_URL_FILE: file
    }, "migration")).toThrow("PLATFORM_CONFIG_INVALID:PDF_APPROVAL_PLATFORM_MIGRATION_DATABASE_URL_FILE");
  });

  it.runIf(process.platform !== "win32")("rejects group-readable production secrets", async () => {
    const root = await tempRoot();
    const file = await secret(root, "permissive", "postgresql://migration:password@db.example/platform");
    await chmod(file, 0o640);
    expect(() => resolveSecretFileEnvironment({
      NODE_ENV: "production",
      PDF_APPROVAL_PLATFORM_MIGRATION_DATABASE_URL_FILE: file
    }, "migration")).toThrow("INSECURE_PRODUCTION_CONFIG:PDF_APPROVAL_PLATFORM_MIGRATION_DATABASE_URL_FILE");
  });

  it.runIf(process.platform !== "win32")("rejects symbolic-link secret files", async () => {
    const root = await tempRoot();
    const source = await secret(root, "source", "postgresql://migration:password@db.example/platform");
    const link = path.join(root, "secret-link");
    await symlink(source, link);
    expect(() => resolveSecretFileEnvironment({
      PDF_APPROVAL_PLATFORM_MIGRATION_DATABASE_URL_FILE: link
    }, "migration")).toThrow("PLATFORM_CONFIG_INVALID:PDF_APPROVAL_PLATFORM_MIGRATION_DATABASE_URL_FILE");
  });
});

async function tempRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "pdf-approval-secret-file-"));
  cleanup.push(root);
  return root;
}

async function secret(root: string, name: string, value: string | Buffer) {
  const target = path.join(root, name);
  await writeFile(target, value, { mode: 0o600 });
  return target;
}
