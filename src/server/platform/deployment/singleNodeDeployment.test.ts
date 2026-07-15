import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(".");

describe("single-node deployment package", () => {
  it("ships one compose with an HTTPS gateway and private stateful dependencies", async () => {
    const compose = await source("deploy/single-node/compose.yaml");
    expect(compose).toContain("gateway:");
    expect(compose).toContain("web:");
    expect(compose).toContain("worker:");
    expect(compose).toContain("postgres:");
    expect(compose).toContain("minio:");
    expect(compose).toContain('PDF_APPROVAL_DEPLOYMENT_PROFILE: single-node');
    expect(compose).toContain('PDF_APPROVAL_STORAGE_S3_ENDPOINT: http://minio:9000');
    expect(compose).toContain('condition: service_healthy');
    expect(compose).toContain('condition: service_completed_successfully');
    expect(compose).toContain('name: pdf-approval-single-node-postgres-data');
    expect(compose).toContain('name: pdf-approval-single-node-minio-data');
    expect(compose).toMatch(/image: caddy:2@sha256:[a-f0-9]{64}/);
    expect(compose).toMatch(/gateway:[\s\S]*?ports:[\s\S]*?"80:80"[\s\S]*?"443:443"/);
    const postgresBlock = compose.slice(compose.indexOf("\n  postgres:\n"), compose.indexOf("\n  minio:\n"));
    const minioBlock = compose.slice(compose.indexOf("\n  minio:\n"), compose.indexOf("\n  minio-init:\n"));
    expect(postgresBlock).not.toContain("ports:");
    expect(minioBlock).not.toContain("ports:");
  });

  it("keeps credentials out of the tracked environment template", async () => {
    const environment = await source("deploy/single-node/.env.example");
    expect(environment).not.toMatch(/PASSWORD=|SECRET=|DATABASE_URL=/);
    expect(environment).toContain("PDF_APPROVAL_DOMAIN=approval.example.com");
    expect(environment).toContain("PDF_APPROVAL_IMAGE=ghcr.io/limericko/pdf-drawing-approval:");
  });

  it("provides one installer and one maintenance command surface", async () => {
    const installer = await source("deploy/single-node/install.sh");
    const operations = await source("deploy/single-node/ops.sh");
    expect(installer).toContain("openssl rand");
    expect(installer).toContain("compose --profile tools run --rm migration");
    expect(installer).toContain("compose --profile tools run --rm bootstrap-admin");
    expect(installer).toContain("compose up -d web worker gateway");
    expect(operations).toContain("pg_dump");
    expect(operations).toContain("mc mirror");
    expect(operations).toContain("升级失败，正在恢复旧镜像");
    expect(operations).toContain("restore)");
  });

  it("excludes generated configuration, runtime data and backups from git", async () => {
    const ignored = await source("deploy/single-node/.gitignore");
    expect(ignored).toContain(".env");
    expect(ignored).toContain("runtime/");
    expect(ignored).toContain("backups/");
  });
});

function source(relativePath: string) {
  return readFile(path.join(root, relativePath), "utf8");
}
