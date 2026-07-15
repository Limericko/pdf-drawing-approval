import { describe, expect, it } from "vitest";
import { assertLocalPlatformE2EEnvironment } from "./localEnvironment.ts";

const localEnv: NodeJS.ProcessEnv = {
  PDF_APPROVAL_PLATFORM_TEST_ADMIN_DATABASE_URL:
    "postgresql://postgres:local-only-postgres-admin@127.0.0.1:55432/postgres",
  PDF_APPROVAL_PLATFORM_TEST_DATABASE_URL:
    "postgresql://platform_migration:local-only-platform-migration@127.0.0.1:55432/pdf_approval_platform",
  PDF_APPROVAL_PLATFORM_MIGRATION_DATABASE_URL:
    "postgresql://platform_migration:local-only-platform-migration@127.0.0.1:55432/pdf_approval_platform",
  PDF_APPROVAL_PLATFORM_WEB_DATABASE_URL:
    "postgresql://platform_web:local-only-platform-web@127.0.0.1:55432/pdf_approval_platform",
  PDF_APPROVAL_PLATFORM_WORKER_DATABASE_URL:
    "postgresql://platform_worker:local-only-platform-worker@127.0.0.1:55432/pdf_approval_platform",
  PDF_APPROVAL_PLATFORM_BOOTSTRAP_DATABASE_URL:
    "postgresql://platform_bootstrap:local-only-platform-bootstrap@127.0.0.1:55432/pdf_approval_platform",
  PDF_APPROVAL_STORAGE_DRIVER: "s3",
  PDF_APPROVAL_STORAGE_S3_ENDPOINT: "http://127.0.0.1:59000",
  PDF_APPROVAL_STORAGE_S3_REGION: "us-east-1",
  PDF_APPROVAL_STORAGE_S3_BUCKET: "pdf-approval",
  PDF_APPROVAL_STORAGE_S3_ACCESS_KEY: "local-only-minio-access",
  PDF_APPROVAL_STORAGE_S3_SECRET_KEY: "local-only-minio-secret",
  PDF_APPROVAL_STORAGE_S3_FORCE_PATH_STYLE: "true"
};

describe("platform E2E local environment boundary", () => {
  it("accepts only the fixed local PostgreSQL and S3 test dependencies", () => {
    expect(() => assertLocalPlatformE2EEnvironment(localEnv)).not.toThrow();
  });

  it.each([
    ["remote S3", "PDF_APPROVAL_STORAGE_S3_ENDPOINT", "https://s3.example.test:59000"],
    ["authenticated S3", "PDF_APPROVAL_STORAGE_S3_ENDPOINT", "http://user:secret@127.0.0.1:59000"],
    ["dangerous bucket", "PDF_APPROVAL_STORAGE_S3_BUCKET", "production-documents"],
    ["path-style disabled", "PDF_APPROVAL_STORAGE_S3_FORCE_PATH_STYLE", "false"],
    ["non-local access key", "PDF_APPROVAL_STORAGE_S3_ACCESS_KEY", "production-key"],
    ["non-local secret key", "PDF_APPROVAL_STORAGE_S3_SECRET_KEY", "production-secret"]
  ])("rejects %s before S3 can be contacted", (_name, key, value) => {
    expect(() => assertLocalPlatformE2EEnvironment({ ...localEnv, [key]: value }))
      .toThrow("PLATFORM_E2E_DEPENDENCY_NOT_LOCAL");
  });

  it.each([
    ["remote admin", "PDF_APPROVAL_PLATFORM_TEST_ADMIN_DATABASE_URL",
      "postgresql://postgres:local-only-postgres-admin@db.example.test:55432/postgres"],
    ["wrong admin database", "PDF_APPROVAL_PLATFORM_TEST_ADMIN_DATABASE_URL",
      "postgresql://postgres:local-only-postgres-admin@127.0.0.1:55432/pdf_approval_platform"],
    ["wrong web role", "PDF_APPROVAL_PLATFORM_WEB_DATABASE_URL",
      "postgresql://platform_worker:local-only-platform-worker@127.0.0.1:55432/pdf_approval_platform"],
    ["wrong worker port", "PDF_APPROVAL_PLATFORM_WORKER_DATABASE_URL",
      "postgresql://platform_worker:local-only-platform-worker@127.0.0.1:5432/pdf_approval_platform"],
    ["mismatched role database", "PDF_APPROVAL_PLATFORM_BOOTSTRAP_DATABASE_URL",
      "postgresql://platform_bootstrap:local-only-platform-bootstrap@127.0.0.1:55432/another_database"]
  ])("rejects %s before PostgreSQL can be contacted", (_name, key, value) => {
    expect(() => assertLocalPlatformE2EEnvironment({ ...localEnv, [key]: value }))
      .toThrow("PLATFORM_E2E_DEPENDENCY_NOT_LOCAL");
  });
});
