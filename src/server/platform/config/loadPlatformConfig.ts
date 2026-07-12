import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { isTrustedProductionS3EndpointHostname } from "./trustedProductionS3Endpoint.ts";
import { PlatformConfigError } from "./types.ts";
import type {
  BootstrapPlatformConfig,
  FilesystemStorageConfig,
  MigrationPlatformConfig,
  PlatformConfig,
  PlatformDatabaseConfig,
  PlatformEnvironment,
  PlatformProcessTarget,
  PlatformSessionConfig,
  PlatformSmtpConfig,
  PlatformStorageConfig,
  PlatformWorkerConfig,
  S3StorageConfig,
  TrustedProxyConfig,
  VersionedKeyring,
  WebPlatformConfig,
  WorkerPlatformConfig
} from "./types.ts";

const databaseFields: Record<PlatformProcessTarget, string> = {
  web: "PDF_APPROVAL_PLATFORM_WEB_DATABASE_URL",
  worker: "PDF_APPROVAL_PLATFORM_WORKER_DATABASE_URL",
  migration: "PDF_APPROVAL_PLATFORM_MIGRATION_DATABASE_URL",
  "bootstrap-admin": "PDF_APPROVAL_PLATFORM_BOOTSTRAP_DATABASE_URL"
};

const s3Fields = [
  "PDF_APPROVAL_STORAGE_S3_ENDPOINT",
  "PDF_APPROVAL_STORAGE_S3_REGION",
  "PDF_APPROVAL_STORAGE_S3_BUCKET",
  "PDF_APPROVAL_STORAGE_S3_ACCESS_KEY",
  "PDF_APPROVAL_STORAGE_S3_SECRET_KEY",
  "PDF_APPROVAL_STORAGE_S3_FORCE_PATH_STYLE"
] as const;
const minimumProductionS3AccessKeyLength = 8;
const minimumProductionS3SecretKeyLength = 16;
const smtpFromSchema = z.string().max(254).email();

type ParsedKeyring = { value: VersionedKeyring; raw: string; field: string };

export function loadPlatformConfig<TTarget extends PlatformProcessTarget>(
  env: NodeJS.ProcessEnv,
  target: TTarget
): Extract<PlatformConfig, { target: TTarget }>;
export function loadPlatformConfig(env: NodeJS.ProcessEnv, target: PlatformProcessTarget): PlatformConfig {
  if (!Object.hasOwn(databaseFields, target)) configInvalid("target");
  const environment = resolveEnvironment(env.NODE_ENV);
  const database = loadDatabaseConfig(env, target);

  if (target === "migration") {
    const config: MigrationPlatformConfig = { target, environment, database };
    if (environment === "production") assertProductionDatabase(database, databaseFields[target]);
    return config;
  }

  if (target === "bootstrap-admin") {
    const totpEncryption = parseKeyring(env, "PDF_APPROVAL_TOTP_KEYRING", environment);
    const recoveryHmac = parseKeyring(env, "PDF_APPROVAL_RECOVERY_HMAC_KEYRING", environment);
    assertDistinctKeyrings([totpEncryption, recoveryHmac]);
    const config: BootstrapPlatformConfig = {
      target,
      environment,
      database,
      keyrings: { totpEncryption: totpEncryption.value, recoveryHmac: recoveryHmac.value }
    };
    if (environment === "production") {
      assertProductionDatabase(database, databaseFields[target]);
      assertProductionKeyrings([totpEncryption, recoveryHmac]);
    }
    return config;
  }

  const storage = loadStorageConfig(env);
  const invitationHmac = parseKeyring(env, "PDF_APPROVAL_INVITATION_HMAC_KEYRING", environment);

  if (target === "worker") {
    const worker = loadWorkerConfig(env);
    if (database.poolMax < worker.concurrency * 2) configInvalid("PDF_APPROVAL_PLATFORM_DB_POOL_MAX");
    const config: WorkerPlatformConfig = {
      target,
      environment,
      database,
      storage,
      smtp: loadSmtpConfig(env),
      publicBaseUrl: parsePublicBaseUrl(env),
      worker,
      keyrings: { invitationHmac: invitationHmac.value }
    };
    assertProductionWorker(config, invitationHmac);
    return config;
  }

  const totpEncryption = parseKeyring(env, "PDF_APPROVAL_TOTP_KEYRING", environment);
  const recoveryHmac = parseKeyring(env, "PDF_APPROVAL_RECOVERY_HMAC_KEYRING", environment);
  const csrfHmac = parseKeyring(env, "PDF_APPROVAL_CSRF_HMAC_KEYRING", environment);
  const parsedKeyrings = [totpEncryption, invitationHmac, recoveryHmac, csrfHmac];
  assertDistinctKeyrings(parsedKeyrings);
  const config: WebPlatformConfig = {
    target,
    environment,
    database,
    storage,
    publicBaseUrl: parsePublicBaseUrl(env),
    trustedProxy: parseTrustedProxy(env),
    session: loadSessionConfig(env),
    keyrings: {
      totpEncryption: totpEncryption.value,
      invitationHmac: invitationHmac.value,
      recoveryHmac: recoveryHmac.value,
      csrfHmac: csrfHmac.value
    }
  };
  assertProductionWeb(config, parsedKeyrings);
  return config;
}

function resolveEnvironment(value: string | undefined): PlatformEnvironment {
  if (value === undefined) return "development";
  if (value === "development" || value === "test" || value === "production") return value;
  configInvalid("NODE_ENV");
}

function loadDatabaseConfig(env: NodeJS.ProcessEnv, target: PlatformProcessTarget): PlatformDatabaseConfig {
  const field = databaseFields[target];
  const connectionString = requiredTrimmed(env, field);
  parseUrl(connectionString, field, ["postgres:", "postgresql:"]);
  const defaultPoolMax = target === "web" ? 10 : target === "worker" ? 5 : 1;
  return {
    connectionString,
    poolMax: boundedInteger(env, "PDF_APPROVAL_PLATFORM_DB_POOL_MAX", defaultPoolMax, 1, 100),
    connectTimeoutMs: boundedInteger(env, "PDF_APPROVAL_PLATFORM_DB_CONNECT_TIMEOUT_MS", 5000, 100, 60000),
    queryTimeoutMs: boundedInteger(env, "PDF_APPROVAL_PLATFORM_DB_QUERY_TIMEOUT_MS", 30000, 100, 300000),
    lockTimeoutMs: boundedInteger(env, "PDF_APPROVAL_PLATFORM_DB_LOCK_TIMEOUT_MS", 5000, 100, 60000),
    transactionTimeoutMs: boundedInteger(
      env,
      "PDF_APPROVAL_PLATFORM_DB_TRANSACTION_TIMEOUT_MS",
      60000,
      100,
      300000
    )
  };
}

function loadStorageConfig(env: NodeJS.ProcessEnv): PlatformStorageConfig {
  const driver = env.PDF_APPROVAL_STORAGE_DRIVER?.trim();
  if (driver !== "filesystem" && driver !== "s3") configInvalid("PDF_APPROVAL_STORAGE_DRIVER");

  const filesystemConfigured = Boolean(env.PDF_APPROVAL_STORAGE_FILESYSTEM_ROOT?.trim());
  const s3Configured = s3Fields.some((field) => Boolean(env[field]?.trim()));
  if ((driver === "filesystem" && s3Configured) || (driver === "s3" && filesystemConfigured)) {
    configInvalid("PDF_APPROVAL_STORAGE_DRIVER");
  }

  if (driver === "filesystem") {
    const root = requiredTrimmed(env, "PDF_APPROVAL_STORAGE_FILESYSTEM_ROOT");
    if (!path.isAbsolute(root)) configInvalid("PDF_APPROVAL_STORAGE_FILESYSTEM_ROOT");
    const config: FilesystemStorageConfig = { driver, root: path.normalize(root) };
    return config;
  }

  const endpoint = normalizeHttpUrl(
    requiredTrimmed(env, "PDF_APPROVAL_STORAGE_S3_ENDPOINT"),
    "PDF_APPROVAL_STORAGE_S3_ENDPOINT"
  );
  const config: S3StorageConfig = {
    driver,
    endpoint,
    region: requiredTrimmed(env, "PDF_APPROVAL_STORAGE_S3_REGION"),
    bucket: requiredTrimmed(env, "PDF_APPROVAL_STORAGE_S3_BUCKET"),
    accessKey: requiredRaw(env, "PDF_APPROVAL_STORAGE_S3_ACCESS_KEY"),
    secretKey: requiredRaw(env, "PDF_APPROVAL_STORAGE_S3_SECRET_KEY"),
    forcePathStyle: requiredBoolean(env, "PDF_APPROVAL_STORAGE_S3_FORCE_PATH_STYLE")
  };
  return config;
}

function loadSessionConfig(env: NodeJS.ProcessEnv): PlatformSessionConfig {
  const absoluteTtlMs = boundedInteger(
    env,
    "PDF_APPROVAL_SESSION_ABSOLUTE_TTL_MS",
    12 * 60 * 60 * 1000,
    5 * 60 * 1000,
    7 * 24 * 60 * 60 * 1000
  );
  const idleTtlMs = boundedInteger(
    env,
    "PDF_APPROVAL_SESSION_IDLE_TTL_MS",
    60 * 60 * 1000,
    60 * 1000,
    24 * 60 * 60 * 1000
  );
  const touchIntervalMs = boundedInteger(
    env,
    "PDF_APPROVAL_SESSION_TOUCH_INTERVAL_MS",
    5 * 60 * 1000,
    1000,
    60 * 60 * 1000
  );
  if (idleTtlMs > absoluteTtlMs) configInvalid("PDF_APPROVAL_SESSION_IDLE_TTL_MS");
  if (touchIntervalMs >= idleTtlMs) configInvalid("PDF_APPROVAL_SESSION_TOUCH_INTERVAL_MS");
  return {
    cookieSecure: optionalBoolean(env, "PDF_APPROVAL_COOKIE_SECURE", true),
    absoluteTtlMs,
    idleTtlMs,
    touchIntervalMs
  };
}

function parseTrustedProxy(env: NodeJS.ProcessEnv): TrustedProxyConfig {
  const raw = env.PDF_APPROVAL_TRUST_PROXY;
  if (raw === undefined || raw === "0") return false;
  if (raw === "loopback") return raw;
  const hops = parseCanonicalUnsignedInteger(raw, "PDF_APPROVAL_TRUST_PROXY");
  if (hops < 1 || hops > 5) configInvalid("PDF_APPROVAL_TRUST_PROXY");
  return hops as 1 | 2 | 3 | 4 | 5;
}

function parsePublicBaseUrl(env: NodeJS.ProcessEnv) {
  const value = requiredTrimmed(env, "PDF_APPROVAL_PUBLIC_BASE_URL");
  const url = parseUrl(value, "PDF_APPROVAL_PUBLIC_BASE_URL", ["http:", "https:"]);
  if (url.username || url.password || url.search || url.hash) configInvalid("PDF_APPROVAL_PUBLIC_BASE_URL");
  return value.replace(/\/+$/, "");
}

function loadSmtpConfig(env: NodeJS.ProcessEnv): PlatformSmtpConfig {
  const host = requiredTrimmed(env, "PDF_APPROVAL_SMTP_HOST");
  const port = boundedInteger(env, "PDF_APPROVAL_SMTP_PORT", 25, 1, 65535);
  const rawFrom = requiredRaw(env, "PDF_APPROVAL_SMTP_FROM");
  const from = rawFrom.trim();
  if (/[\r\n]/.test(rawFrom) || !smtpFromSchema.safeParse(from).success) configInvalid("PDF_APPROVAL_SMTP_FROM");
  return {
    host,
    port,
    from,
    secure: optionalBoolean(env, "PDF_APPROVAL_SMTP_SECURE", port === 465),
    requireTls: optionalBoolean(env, "PDF_APPROVAL_SMTP_REQUIRE_TLS", false),
    username: optionalRaw(env, "PDF_APPROVAL_SMTP_USER"),
    password: optionalRaw(env, "PDF_APPROVAL_SMTP_PASSWORD")
  };
}

function loadWorkerConfig(env: NodeJS.ProcessEnv): PlatformWorkerConfig {
  const retryBaseMs = boundedInteger(env, "PDF_APPROVAL_WORKER_RETRY_BASE_MS", 1000, 1, 60000);
  const retryMaxMs = boundedInteger(env, "PDF_APPROVAL_WORKER_RETRY_MAX_MS", 60000, 1000, 86400000);
  if (retryMaxMs < retryBaseMs) configInvalid("PDF_APPROVAL_WORKER_RETRY_MAX_MS");
  return {
    concurrency: boundedInteger(env, "PDF_APPROVAL_WORKER_CONCURRENCY", 2, 1, 100),
    leaseMs: boundedInteger(env, "PDF_APPROVAL_WORKER_LEASE_MS", 30000, 1000, 3600000),
    maxAttempts: boundedInteger(env, "PDF_APPROVAL_WORKER_MAX_ATTEMPTS", 5, 1, 100),
    retryBaseMs,
    retryMaxMs,
    storageCleanupReapIntervalMs: boundedInteger(
      env,
      "PDF_APPROVAL_STORAGE_CLEANUP_REAP_INTERVAL_MS",
      6 * 60 * 60 * 1_000,
      60_000,
      7 * 24 * 60 * 60 * 1_000
    )
  };
}

function parseKeyring(env: NodeJS.ProcessEnv, field: string, environment: PlatformEnvironment): ParsedKeyring {
  const raw = requiredRaw(env, field);
  if (raw.startsWith("local-only-")) {
    if (environment === "production") insecure(field);
    return {
      field,
      raw,
      value: { currentVersion: "local-v1", keys: new Map([["local-v1", createHash("sha256").update(raw).digest()]]) }
    };
  }

  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    configInvalid(field);
  }
  if (!isRecord(input) || typeof input.currentVersion !== "string" || !isRecord(input.keys)) configInvalid(field);
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(input.currentVersion)) configInvalid(field);

  const keys = new Map<string, Buffer>();
  const seen = new Set<string>();
  for (const [version, encoded] of Object.entries(input.keys)) {
    if (!/^[A-Za-z0-9._-]{1,32}$/.test(version) || typeof encoded !== "string") configInvalid(field);
    const material = decodeKey(encoded, field);
    if (material.length < 32 || material.length > 128) configInvalid(field);
    const fingerprint = material.toString("hex");
    if (seen.has(fingerprint)) configInvalid(field);
    seen.add(fingerprint);
    keys.set(version, material);
  }
  if (keys.size === 0 || !keys.has(input.currentVersion)) configInvalid(field);
  return { field, raw, value: { currentVersion: input.currentVersion, keys } };
}

function decodeKey(value: string, field: string) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) configInvalid(field);
  return Buffer.from(value, "base64");
}

function assertDistinctKeyrings(keyrings: ParsedKeyring[]) {
  const owners = new Map<string, string>();
  for (const keyring of keyrings) {
    for (const material of keyring.value.keys.values()) {
      const fingerprint = material.toString("hex");
      if (owners.has(fingerprint)) configInvalid("KEYRING_MATERIAL_REUSED");
      owners.set(fingerprint, keyring.field);
    }
  }
}

function assertProductionWeb(config: WebPlatformConfig, keyrings: ParsedKeyring[]) {
  if (config.environment !== "production") return;
  if (!config.session.cookieSecure) insecure("PDF_APPROVAL_COOKIE_SECURE");
  if (!config.publicBaseUrl.startsWith("https://")) insecure("PDF_APPROVAL_PUBLIC_BASE_URL");
  assertProductionDatabase(config.database, databaseFields.web);
  assertProductionStorage(config.storage);
  assertProductionKeyrings(keyrings);
}

function assertProductionWorker(config: WorkerPlatformConfig, invitationHmac: ParsedKeyring) {
  if (config.environment !== "production") return;
  const host = config.smtp.host.toLowerCase();
  if (["127.0.0.1", "localhost", "::1", "mailpit"].includes(host) || [1025, 51025, 8025, 58025].includes(config.smtp.port)) {
    insecure("PDF_APPROVAL_SMTP_HOST");
  }
  if (!config.smtp.username) insecure("PDF_APPROVAL_SMTP_USER");
  if (!config.smtp.password) insecure("PDF_APPROVAL_SMTP_PASSWORD");
  if ((config.smtp.port === 465) !== config.smtp.secure) insecure("PDF_APPROVAL_SMTP_SECURE");
  if (!config.smtp.secure && !config.smtp.requireTls) insecure("PDF_APPROVAL_SMTP_REQUIRE_TLS");
  if (isUnsafeText(config.smtp.password)) insecure("PDF_APPROVAL_SMTP_PASSWORD");
  if (!config.publicBaseUrl.startsWith("https://")) insecure("PDF_APPROVAL_PUBLIC_BASE_URL");
  assertProductionDatabase(config.database, databaseFields.worker);
  assertProductionStorage(config.storage);
  assertProductionKeyrings([invitationHmac]);
}

function assertProductionDatabase(database: PlatformDatabaseConfig, field: string) {
  const url = new URL(database.connectionString);
  if (isUnsafeText(database.connectionString) || isUnsafeText(safeDecode(url.password))) insecure(field);
}

function assertProductionStorage(storage: PlatformStorageConfig) {
  if (storage.driver !== "s3") return;
  const endpoint = new URL(storage.endpoint);
  if (endpoint.protocol !== "https:" || !isTrustedProductionS3EndpointHostname(endpoint.hostname)) {
    insecure("PDF_APPROVAL_STORAGE_S3_ENDPOINT");
  }
  if (
    storage.accessKey !== storage.accessKey.trim() ||
    storage.accessKey.length < minimumProductionS3AccessKeyLength ||
    isUnsafeText(storage.accessKey) ||
    /minio/i.test(storage.accessKey)
  ) {
    insecure("PDF_APPROVAL_STORAGE_S3_ACCESS_KEY");
  }
  if (
    storage.secretKey !== storage.secretKey.trim() ||
    storage.secretKey.length < minimumProductionS3SecretKeyLength ||
    isUnsafeText(storage.secretKey) ||
    /minio/i.test(storage.secretKey)
  ) {
    insecure("PDF_APPROVAL_STORAGE_S3_SECRET_KEY");
  }
}

function assertProductionKeyrings(keyrings: ParsedKeyring[]) {
  for (const keyring of keyrings) {
    if (keyring.raw.startsWith("local-only-")) insecure(keyring.field);
    for (const material of keyring.value.keys.values()) {
      if (isUnsafeText(material.toString("utf8"))) insecure(keyring.field);
    }
  }
}

function requiredTrimmed(env: NodeJS.ProcessEnv, field: string) {
  const value = env[field]?.trim();
  if (!value) configInvalid(field);
  return value;
}

function requiredRaw(env: NodeJS.ProcessEnv, field: string) {
  const value = env[field];
  if (!value?.trim()) configInvalid(field);
  return value;
}

function optionalRaw(env: NodeJS.ProcessEnv, field: string) {
  const value = env[field];
  return value?.trim() ? value : undefined;
}

function boundedInteger(env: NodeJS.ProcessEnv, field: string, fallback: number, min: number, max: number) {
  const raw = env[field];
  if (raw === undefined || raw === "") return fallback;
  const value = parseCanonicalUnsignedInteger(raw, field);
  if (value < min || value > max) configInvalid(field);
  return value;
}

function parseCanonicalUnsignedInteger(raw: string, field: string) {
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) configInvalid(field);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) configInvalid(field);
  return value;
}

function optionalBoolean(env: NodeJS.ProcessEnv, field: string, fallback: boolean) {
  const raw = env[field]?.trim();
  if (!raw) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  configInvalid(field);
}

function requiredBoolean(env: NodeJS.ProcessEnv, field: string) {
  if (!env[field]?.trim()) configInvalid(field);
  return optionalBoolean(env, field, false);
}

function normalizeHttpUrl(value: string, field: string) {
  const url = parseUrl(value, field, ["http:", "https:"]);
  if (url.username || url.password || url.search || url.hash) configInvalid(field);
  return value.replace(/\/+$/, "");
}

function parseUrl(value: string, field: string, protocols: string[]) {
  try {
    const url = new URL(value);
    if (!protocols.includes(url.protocol) || !url.hostname) configInvalid(field);
    return url;
  } catch {
    configInvalid(field);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isUnsafeText(value: string) {
  return /(local-only|change-this|default-secret|example-secret)/i.test(value);
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function configInvalid(field: string): never {
  return throwConfigError("PLATFORM_CONFIG_INVALID", field);
}

function insecure(field: string): never {
  return throwConfigError("INSECURE_PRODUCTION_CONFIG", field);
}

function throwConfigError(code: "PLATFORM_CONFIG_INVALID" | "INSECURE_PRODUCTION_CONFIG", field: string): never {
  throw new PlatformConfigError(code, field);
}
