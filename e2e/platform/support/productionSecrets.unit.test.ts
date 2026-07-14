import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materializeProductionSecrets } from "../../../deploy/materialize-secrets.mjs";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe("production secret materialization", () => {
  it("writes the exact least-privilege service file layout without secret output", async () => {
    const root = await targetRoot();
    const result = await materializeProductionSecrets({ bundle: validBundle(), root,
      uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 });

    expect(result).toEqual({ root, files: 17 });
    await expect(readFile(path.join(root, "web", "database-url.secret"), "utf8"))
      .resolves.toBe("postgresql://platform_web:strong-password@db.example/platform");
    await expect(readFile(path.join(root, "worker", "webdav-credentials.json"), "utf8"))
      .resolves.toBe("{}");
    await expect(readFile(path.join(root, "web", "s3-access-key.secret"), "utf8"))
      .resolves.toBe("production-access-key");
    await expect(stat(path.join(root, "web", "oss-access-key.secret"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(path.join(root, "web", "smtp-password.secret"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(path.join(root, "worker", "csrf-hmac-keyring.secret"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("atomically replaces a complete bundle during rotation", async () => {
    const root = await targetRoot();
    const first = validBundle();
    await materializeProductionSecrets({ bundle: first, root,
      uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 });
    const rotated = validBundle();
    rotated.smtp.password = "rotated-smtp-password";
    await materializeProductionSecrets({ bundle: rotated, root,
      uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 });
    await expect(readFile(path.join(root, "worker", "smtp-password.secret"), "utf8"))
      .resolves.toBe("rotated-smtp-password");
  });

  it("rejects unknown fields, reused key material and invalid WebDAV credentials", async () => {
    const root = await targetRoot();
    const unknown = { ...validBundle(), unexpected: "secret" };
    await expect(materializeProductionSecrets({ bundle: unknown, root }))
      .rejects.toMatchObject({ code: "PRODUCTION_SECRET_BUNDLE_INVALID", field: "bundle" });

    const reused = validBundle();
    reused.keyrings.csrf = structuredClone(reused.keyrings.totp);
    await expect(materializeProductionSecrets({ bundle: reused, root }))
      .rejects.toMatchObject({ code: "PRODUCTION_SECRET_BUNDLE_INVALID", field: "keyrings.materialReused" });

    const webdav = validBundle();
    webdav.webdavCredentials = { "secret/webdav": { username: "bad:user", password: "password" } };
    await expect(materializeProductionSecrets({ bundle: webdav, root }))
      .rejects.toMatchObject({ code: "PRODUCTION_SECRET_BUNDLE_INVALID",
        field: "webdavCredentials.secret/webdav.username" });
  });
});

async function targetRoot() {
  const parent = await mkdtemp(path.join(tmpdir(), "pdf-approval-production-secrets-"));
  cleanup.push(parent);
  return path.join(parent, "materialized");
}

function validBundle() {
  return {
    database: {
      webUrl: "postgresql://platform_web:strong-password@db.example/platform",
      workerUrl: "postgresql://platform_worker:strong-password@db.example/platform",
      migrationUrl: "postgresql://platform_migration:strong-password@db.example/platform",
      bootstrapUrl: "postgresql://platform_bootstrap:strong-password@db.example/platform"
    },
    storage: { accessKey: "production-access-key", secretKey: "production-secret-key" },
    smtp: { password: "production-smtp-password" },
    keyrings: {
      totp: keyring(1), invitation: keyring(2), recovery: keyring(3), csrf: keyring(4)
    },
    webdavCredentials: {}
  };
}

function keyring(byte: number) {
  return { currentVersion: "v1", keys: { v1: Buffer.alloc(32, byte).toString("base64") } };
}
