import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(".");

describe("production deployment boundary", () => {
  it("builds one non-root production image with exact process targets", async () => {
    const dockerfile = await source("Dockerfile");
    const entrypoint = await source("deploy/container-entrypoint.sh");
    expect(dockerfile).toContain("npm ci --omit=dev");
    expect(dockerfile).toContain("USER 10001:10001");
    expect(dockerfile).toContain("ENTRYPOINT [\"/app/deploy/container-entrypoint.sh\"]");
    expect(entrypoint).toMatch(/web\)[\s\S]*exec node --import tsx src\/server\/index\.ts/);
    expect(entrypoint).toMatch(/worker\)[\s\S]*exec node --import tsx src\/server\/platform\/jobs\/workerMain\.ts/);
    expect(entrypoint).toMatch(/migration\)[\s\S]*exec node --import tsx src\/server\/platform\/database\/migrateCli\.ts/);
    expect(entrypoint).toMatch(/bootstrap-admin\)[\s\S]*exec node --import tsx src\/server\/commands\/bootstrapAdmin\.ts/);
  });

  it("keeps production services immutable and mounts separate read-only secret directories", async () => {
    const compose = await source("deploy/compose.production.yaml");
    const healthcheck = await source("deploy/healthcheck.mjs");
    expect(compose).toContain("image: ${PDF_APPROVAL_IMAGE:?");
    expect(compose).toContain("read_only: true");
    expect(compose).toContain("cap_drop: [\"ALL\"]");
    expect(compose).toContain("no-new-privileges:true");
    expect(compose).toContain("PDF_APPROVAL_WEB_SECRET_DIR");
    expect(compose).toContain("PDF_APPROVAL_WORKER_SECRET_DIR");
    expect(compose).toContain("PDF_APPROVAL_MIGRATION_SECRET_DIR");
    expect(compose).toContain("PDF_APPROVAL_BOOTSTRAP_SECRET_DIR");
    expect(compose).toContain("PDF_APPROVAL_STORAGE_S3_ALLOWED_HOSTS");
    expect(compose).toContain("s3-access-key.secret");
    expect(compose).not.toContain("oss-access-key.secret");
    expect(compose).not.toContain("cn-hongkong");
    expect(healthcheck).toContain("/health/ready");
    expect(compose).not.toMatch(/^\s+PDF_APPROVAL_(?:PLATFORM_.*DATABASE_URL|STORAGE_S3_SECRET_KEY|SMTP_PASSWORD):/m);
  });

  it("does not put concrete credential material in tracked deployment examples", async () => {
    const combined = [
      await source("deploy/compose.production.yaml"),
      await source("deploy/production.env.example"),
      await source("deploy/secret-bundle.example.json")
    ].join("\n");
    expect(combined).not.toMatch(/postgresql:\/\/[^:\s]+:[^@\s]*[A-Za-z0-9]{16,}@/);
    expect(combined).not.toMatch(/AKID[A-Za-z0-9]{12,}/);
    expect(combined).not.toMatch(/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/);
  });

  it("keeps the production package independent from a cloud vendor", async () => {
    const combined = [
      await source("deploy/compose.production.yaml"),
      await source("deploy/production.env.example"),
      await source("deploy/README.md")
    ].join("\n");
    expect(combined).not.toMatch(/registry\.cn-hongkong\.aliyuncs\.com|oss-cn-hongkong\.aliyuncs\.com/);
    expect(combined).toContain("Docker/OCI");
    expect(combined).toContain("S3");
  });
});

function source(relativePath: string) {
  return readFile(path.join(root, relativePath), "utf8");
}
