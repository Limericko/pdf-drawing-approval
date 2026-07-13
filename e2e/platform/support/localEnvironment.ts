import type { PlatformTestDatabase } from "../../../src/server/platform/testing/postgresHarness.ts";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const POSTGRES_PORT = "55432";
const S3_PORT = "59000";
const BASE_DATABASE = "pdf_approval_platform";

const DATABASE_FIELDS = Object.freeze({
  PDF_APPROVAL_PLATFORM_TEST_ADMIN_DATABASE_URL: {
    username: "postgres", password: "local-only-postgres-admin", database: "postgres"
  },
  PDF_APPROVAL_PLATFORM_TEST_DATABASE_URL: {
    username: "platform_migration", password: "local-only-platform-migration", database: BASE_DATABASE
  },
  PDF_APPROVAL_PLATFORM_MIGRATION_DATABASE_URL: {
    username: "platform_migration", password: "local-only-platform-migration", database: BASE_DATABASE
  },
  PDF_APPROVAL_PLATFORM_WEB_DATABASE_URL: {
    username: "platform_web", password: "local-only-platform-web", database: BASE_DATABASE
  },
  PDF_APPROVAL_PLATFORM_WORKER_DATABASE_URL: {
    username: "platform_worker", password: "local-only-platform-worker", database: BASE_DATABASE
  },
  PDF_APPROVAL_PLATFORM_BOOTSTRAP_DATABASE_URL: {
    username: "platform_bootstrap", password: "local-only-platform-bootstrap", database: BASE_DATABASE
  }
} as const);

const LOCAL_PLATFORM_VALUES = Object.freeze({
  PDF_APPROVAL_STORAGE_DRIVER: "s3",
  PDF_APPROVAL_STORAGE_S3_REGION: "us-east-1",
  PDF_APPROVAL_STORAGE_S3_BUCKET: "pdf-approval",
  PDF_APPROVAL_STORAGE_S3_ACCESS_KEY: "local-only-minio-access",
  PDF_APPROVAL_STORAGE_S3_SECRET_KEY: "local-only-minio-secret",
  PDF_APPROVAL_STORAGE_S3_FORCE_PATH_STYLE: "true"
} as const);

const LOCAL_RUNTIME_VALUES = Object.freeze({
  PDF_APPROVAL_SMTP_HOST: "127.0.0.1",
  PDF_APPROVAL_SMTP_PORT: "51025",
  PDF_APPROVAL_SMTP_FROM: "pdf-approval@local.test",
  PDF_APPROVAL_SMTP_SECURE: "false",
  PDF_APPROVAL_SMTP_REQUIRE_TLS: "false",
  PDF_APPROVAL_COOKIE_SECURE: "false",
  PDF_APPROVAL_TOTP_KEYRING: "local-only-task-3-totp-keyring",
  PDF_APPROVAL_INVITATION_HMAC_KEYRING: "local-only-task-3-invitation-keyring",
  PDF_APPROVAL_RECOVERY_HMAC_KEYRING: "local-only-task-3-recovery-keyring",
  PDF_APPROVAL_CSRF_HMAC_KEYRING: "local-only-task-3-csrf-keyring",
  PDF_APPROVAL_WORKER_LEASE_MS: "30000",
  PDF_APPROVAL_WORKER_MAX_ATTEMPTS: "5",
  PDF_APPROVAL_STORAGE_CLEANUP_REAP_INTERVAL_MS: "21600000"
} as const);

export function assertLocalPlatformE2EEnvironment(env: NodeJS.ProcessEnv) {
  for (const [field, expected] of Object.entries(DATABASE_FIELDS)) {
    assertDatabaseUrl(env[field], expected);
  }
  assertLocalS3Endpoint(env.PDF_APPROVAL_STORAGE_S3_ENDPOINT);
  for (const [field, expected] of Object.entries(LOCAL_PLATFORM_VALUES)) {
    if (env[field] !== expected) dependencyNotLocal();
  }
}

export function createPlatformE2ERunEnvironment(
  base: NodeJS.ProcessEnv,
  database: Pick<PlatformTestDatabase, "databaseName" | "urls">,
  input: { readonly apiPort: number; readonly webUrl: string }
) {
  assertLocalPlatformE2EEnvironment(base);
  if (!/^pdf_approval_test_[0-9a-f]{32}$/.test(database.databaseName)) dependencyNotLocal();
  assertGeneratedRoleUrl(database.urls.migration, "platform_migration", "local-only-platform-migration", database.databaseName);
  assertGeneratedRoleUrl(database.urls.web, "platform_web", "local-only-platform-web", database.databaseName);
  assertGeneratedRoleUrl(database.urls.worker, "platform_worker", "local-only-platform-worker", database.databaseName);
  assertGeneratedRoleUrl(database.urls.bootstrap, "platform_bootstrap", "local-only-platform-bootstrap", database.databaseName);

  const env = withoutPlatformVariables(base);
  Object.assign(env, {
    NODE_ENV: "test",
    PDF_APPROVAL_RUNTIME_MODE: "platform",
    PDF_APPROVAL_PLATFORM_MIGRATION_DATABASE_URL: database.urls.migration,
    PDF_APPROVAL_PLATFORM_WEB_DATABASE_URL: database.urls.web,
    PDF_APPROVAL_PLATFORM_WORKER_DATABASE_URL: database.urls.worker,
    PDF_APPROVAL_PLATFORM_BOOTSTRAP_DATABASE_URL: database.urls.bootstrap,
    PDF_APPROVAL_STORAGE_DRIVER: LOCAL_PLATFORM_VALUES.PDF_APPROVAL_STORAGE_DRIVER,
    PDF_APPROVAL_STORAGE_S3_ENDPOINT: normalizeLocalS3Endpoint(base.PDF_APPROVAL_STORAGE_S3_ENDPOINT),
    PDF_APPROVAL_STORAGE_S3_REGION: LOCAL_PLATFORM_VALUES.PDF_APPROVAL_STORAGE_S3_REGION,
    PDF_APPROVAL_STORAGE_S3_BUCKET: LOCAL_PLATFORM_VALUES.PDF_APPROVAL_STORAGE_S3_BUCKET,
    PDF_APPROVAL_STORAGE_S3_ACCESS_KEY: LOCAL_PLATFORM_VALUES.PDF_APPROVAL_STORAGE_S3_ACCESS_KEY,
    PDF_APPROVAL_STORAGE_S3_SECRET_KEY: LOCAL_PLATFORM_VALUES.PDF_APPROVAL_STORAGE_S3_SECRET_KEY,
    PDF_APPROVAL_STORAGE_S3_FORCE_PATH_STYLE: LOCAL_PLATFORM_VALUES.PDF_APPROVAL_STORAGE_S3_FORCE_PATH_STYLE,
    ...LOCAL_RUNTIME_VALUES,
    PDF_APPROVAL_PUBLIC_BASE_URL: input.webUrl,
    PDF_APPROVAL_WORKER_CONCURRENCY: "1",
    PORT: String(input.apiPort)
  });
  return env;
}

function withoutPlatformVariables(base: NodeJS.ProcessEnv) {
  const safe: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (!/^(?:PDF_APPROVAL_|POSTGRES_|PLATFORM_|MINIO_|COMPOSE_PROJECT_NAME$|NODE_ENV$)/.test(key)) safe[key] = value;
  }
  return safe;
}

function assertDatabaseUrl(value: string | undefined, expected: {
  readonly username: string; readonly password: string; readonly database: string;
}) {
  const url = parseLocalUrl(value, new Set(["postgres:", "postgresql:"]), POSTGRES_PORT);
  if (decode(url.username) !== expected.username || decode(url.password) !== expected.password ||
      decode(url.pathname.replace(/^\/+|\/+$/g, "")) !== expected.database || url.search || url.hash) {
    dependencyNotLocal();
  }
}

function assertGeneratedRoleUrl(value: string, username: string, password: string, database: string) {
  assertDatabaseUrl(value, { username, password, database });
}

function assertLocalS3Endpoint(value: string | undefined) {
  const url = parseLocalUrl(value, new Set(["http:"]), S3_PORT);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) dependencyNotLocal();
}

function normalizeLocalS3Endpoint(value: string | undefined) {
  assertLocalS3Endpoint(value);
  return new URL(value!).href.replace(/\/$/, "");
}

function parseLocalUrl(value: string | undefined, protocols: ReadonlySet<string>, port: string) {
  let url: URL;
  try { url = new URL(value ?? ""); } catch { dependencyNotLocal(); }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!protocols.has(url.protocol) || !LOOPBACK_HOSTS.has(hostname) || url.port !== port) dependencyNotLocal();
  return url;
}

function decode(value: string) {
  try { return decodeURIComponent(value); } catch { dependencyNotLocal(); }
}

function dependencyNotLocal(): never {
  throw new Error("PLATFORM_E2E_DEPENDENCY_NOT_LOCAL");
}
