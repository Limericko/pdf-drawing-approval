import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadPlatformConfig } from "./loadPlatformConfig.ts";

const webDatabaseUrl = "postgresql://platform_web:p%40ss%3Aword@db.example:5432/platform";
const workerDatabaseUrl = "postgresql://platform_worker:worker-password@db.example:5432/platform";
const migrationDatabaseUrl = "postgresql://platform_migration:migration-password@db.example:5432/platform";
const bootstrapDatabaseUrl = "postgresql://platform_bootstrap:bootstrap-password@db.example:5432/platform";
const filesystemRoot = path.resolve(".cache", "platform-files");

function keyring(byte: number, currentVersion = "v1", extra: Record<string, string> = {}) {
  return JSON.stringify({
    currentVersion,
    keys: {
      v1: Buffer.alloc(32, byte).toString("base64"),
      ...extra
    }
  });
}

function webEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "development",
    PDF_APPROVAL_PLATFORM_WEB_DATABASE_URL: webDatabaseUrl,
    PDF_APPROVAL_STORAGE_DRIVER: "filesystem",
    PDF_APPROVAL_STORAGE_FILESYSTEM_ROOT: filesystemRoot,
    PDF_APPROVAL_PUBLIC_BASE_URL: "http://127.0.0.1:8080/app/",
    PDF_APPROVAL_COOKIE_SECURE: "false",
    PDF_APPROVAL_TRUST_PROXY: "1",
    PDF_APPROVAL_TOTP_KEYRING: keyring(1),
    PDF_APPROVAL_INVITATION_HMAC_KEYRING: keyring(2),
    PDF_APPROVAL_RECOVERY_HMAC_KEYRING: keyring(3),
    PDF_APPROVAL_CSRF_HMAC_KEYRING: keyring(4),
    ...overrides
  };
}

function workerEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "development",
    PDF_APPROVAL_PLATFORM_WORKER_DATABASE_URL: workerDatabaseUrl,
    PDF_APPROVAL_STORAGE_DRIVER: "s3",
    PDF_APPROVAL_STORAGE_S3_ENDPOINT: "http://127.0.0.1:59000",
    PDF_APPROVAL_STORAGE_S3_REGION: "us-east-1",
    PDF_APPROVAL_STORAGE_S3_BUCKET: "pdf-approval",
    PDF_APPROVAL_STORAGE_S3_ACCESS_KEY: "local-dev-access",
    PDF_APPROVAL_STORAGE_S3_SECRET_KEY: "local-dev-secret",
    PDF_APPROVAL_STORAGE_S3_FORCE_PATH_STYLE: "true",
    PDF_APPROVAL_SMTP_HOST: "127.0.0.1",
    PDF_APPROVAL_SMTP_PORT: "51025",
    PDF_APPROVAL_SMTP_FROM: "pdf-approval@local.test",
    PDF_APPROVAL_WORKER_CONCURRENCY: "2",
    PDF_APPROVAL_WORKER_LEASE_MS: "30000",
    PDF_APPROVAL_WORKER_MAX_ATTEMPTS: "5",
    PDF_APPROVAL_INVITATION_HMAC_KEYRING: keyring(2),
    ...overrides
  };
}

function bootstrapEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "development",
    PDF_APPROVAL_PLATFORM_BOOTSTRAP_DATABASE_URL: bootstrapDatabaseUrl,
    PDF_APPROVAL_TOTP_KEYRING: keyring(1),
    PDF_APPROVAL_RECOVERY_HMAC_KEYRING: keyring(3),
    ...overrides
  };
}

describe("loadPlatformConfig target composition", () => {
  it("loads a filesystem-backed web config with secure session defaults", () => {
    const config = loadPlatformConfig(webEnv(), "web");

    expect(config.target).toBe("web");
    expect(config.database.connectionString).toBe(webDatabaseUrl);
    expect(config.storage).toEqual({ driver: "filesystem", root: filesystemRoot });
    expect(config.publicBaseUrl).toBe("http://127.0.0.1:8080/app");
    expect(config.trustedProxy).toBe(1);
    expect(config.session).toEqual({
      cookieSecure: false,
      absoluteTtlMs: 12 * 60 * 60 * 1000,
      idleTtlMs: 60 * 60 * 1000,
      touchIntervalMs: 5 * 60 * 1000
    });
    expect(config.keyrings.totpEncryption.keys).toBeInstanceOf(Map);
    expect(config.keyrings.totpEncryption.keys.get("v1")).toEqual(Buffer.alloc(32, 1));
  });

  it("loads an S3-backed worker config without web-only settings", () => {
    const config = loadPlatformConfig(workerEnv(), "worker");

    expect(config.target).toBe("worker");
    expect(config.database.connectionString).toBe(workerDatabaseUrl);
    expect(config.storage).toEqual({
      driver: "s3",
      endpoint: "http://127.0.0.1:59000",
      region: "us-east-1",
      bucket: "pdf-approval",
      accessKey: "local-dev-access",
      secretKey: "local-dev-secret",
      forcePathStyle: true
    });
    expect(config.smtp).toEqual({
      host: "127.0.0.1",
      port: 51025,
      from: "pdf-approval@local.test",
      secure: false,
      username: undefined,
      password: undefined
    });
    expect(config.worker).toEqual({
      concurrency: 2,
      leaseMs: 30000,
      maxAttempts: 5,
      retryBaseMs: 1000,
      retryMaxMs: 60000
    });
    expect("session" in config).toBe(false);
  });

  it("requires only the migration database for migration", () => {
    const config = loadPlatformConfig(
      {
        NODE_ENV: "development",
        PDF_APPROVAL_PLATFORM_MIGRATION_DATABASE_URL: migrationDatabaseUrl,
        PDF_APPROVAL_STORAGE_DRIVER: "broken",
        PDF_APPROVAL_PLATFORM_WEB_DATABASE_URL: "not-a-url"
      },
      "migration"
    );

    expect(config).toEqual(
      expect.objectContaining({ target: "migration", database: expect.objectContaining({ connectionString: migrationDatabaseUrl }) })
    );
    expect("storage" in config).toBe(false);
    expect(JSON.stringify(config)).not.toContain("not-a-url");
  });

  it("requires only bootstrap database, TOTP and recovery keyrings for bootstrap-admin", () => {
    const config = loadPlatformConfig(
      bootstrapEnv({
        PDF_APPROVAL_STORAGE_DRIVER: "broken",
        PDF_APPROVAL_CSRF_HMAC_KEYRING: "invalid-unused-value"
      }),
      "bootstrap-admin"
    );

    expect(config.target).toBe("bootstrap-admin");
    expect(config.database.connectionString).toBe(bootstrapDatabaseUrl);
    expect(Object.keys(config.keyrings)).toEqual(["totpEncryption", "recoveryHmac"]);
    expect("storage" in config).toBe(false);
  });

  it("does not require worker or migration credentials for web", () => {
    expect(() => loadPlatformConfig(webEnv(), "web")).not.toThrow();
  });

  it("does not require web or migration credentials for worker", () => {
    expect(() => loadPlatformConfig(workerEnv(), "worker")).not.toThrow();
  });
});
describe("database and numeric validation", () => {
  it.each([
    ["web", "PDF_APPROVAL_PLATFORM_WEB_DATABASE_URL", () => webEnv()],
    ["worker", "PDF_APPROVAL_PLATFORM_WORKER_DATABASE_URL", () => workerEnv()],
    ["migration", "PDF_APPROVAL_PLATFORM_MIGRATION_DATABASE_URL", () => ({
      NODE_ENV: "development",
      PDF_APPROVAL_PLATFORM_MIGRATION_DATABASE_URL: migrationDatabaseUrl
    })],
    ["bootstrap-admin", "PDF_APPROVAL_PLATFORM_BOOTSTRAP_DATABASE_URL", () => bootstrapEnv()]
  ] as const)("rejects a non-PostgreSQL URL for %s", (target, key, createEnv) => {
    expect(() => loadPlatformConfig({ ...createEnv(), [key]: "mysql://user:secret@db.example/platform" }, target)).toThrow(
      `PLATFORM_CONFIG_INVALID:${key}`
    );
  });

  it.each([
    ["PDF_APPROVAL_PLATFORM_DB_POOL_MAX", "0"],
    ["PDF_APPROVAL_PLATFORM_DB_POOL_MAX", "101"],
    ["PDF_APPROVAL_PLATFORM_DB_CONNECT_TIMEOUT_MS", "0"],
    ["PDF_APPROVAL_PLATFORM_DB_QUERY_TIMEOUT_MS", "300001"],
    ["PDF_APPROVAL_PLATFORM_DB_LOCK_TIMEOUT_MS", "1.5"],
    ["PDF_APPROVAL_PLATFORM_DB_TRANSACTION_TIMEOUT_MS", "not-a-number"]
  ])("rejects out-of-bounds database setting %s=%s", (key, value) => {
    expect(() => loadPlatformConfig(webEnv({ [key]: value }), "web")).toThrow(`PLATFORM_CONFIG_INVALID:${key}`);
  });

  it("returns bounded database defaults", () => {
    expect(loadPlatformConfig(webEnv(), "web").database).toEqual({
      connectionString: webDatabaseUrl,
      poolMax: 10,
      connectTimeoutMs: 5000,
      queryTimeoutMs: 30000,
      lockTimeoutMs: 5000,
      transactionTimeoutMs: 60000
    });
  });

  it.each([
    ["PDF_APPROVAL_WORKER_CONCURRENCY", "0"],
    ["PDF_APPROVAL_WORKER_CONCURRENCY", "101"],
    ["PDF_APPROVAL_WORKER_LEASE_MS", "999"],
    ["PDF_APPROVAL_WORKER_MAX_ATTEMPTS", "0"],
    ["PDF_APPROVAL_WORKER_RETRY_BASE_MS", "0"],
    ["PDF_APPROVAL_WORKER_RETRY_MAX_MS", "86400001"]
  ])("rejects out-of-bounds worker setting %s=%s", (key, value) => {
    expect(() => loadPlatformConfig(workerEnv({ [key]: value }), "worker")).toThrow(`PLATFORM_CONFIG_INVALID:${key}`);
  });
});

describe("selective storage validation", () => {
  it.each([undefined, "", "azure"])("rejects unknown or missing driver %s", (driver) => {
    expect(() => loadPlatformConfig(webEnv({ PDF_APPROVAL_STORAGE_DRIVER: driver }), "web")).toThrow(
      "PLATFORM_CONFIG_INVALID:PDF_APPROVAL_STORAGE_DRIVER"
    );
  });

  it("rejects a relative filesystem root", () => {
    expect(() =>
      loadPlatformConfig(webEnv({ PDF_APPROVAL_STORAGE_FILESYSTEM_ROOT: "relative/files" }), "web")
    ).toThrow("PLATFORM_CONFIG_INVALID:PDF_APPROVAL_STORAGE_FILESYSTEM_ROOT");
  });

  it("rejects an incomplete S3 config", () => {
    expect(() => loadPlatformConfig(workerEnv({ PDF_APPROVAL_STORAGE_S3_SECRET_KEY: "" }), "worker")).toThrow(
      "PLATFORM_CONFIG_INVALID:PDF_APPROVAL_STORAGE_S3_SECRET_KEY"
    );
  });

  it("rejects credentials embedded in the S3 endpoint", () => {
    expect(() =>
      loadPlatformConfig(workerEnv({ PDF_APPROVAL_STORAGE_S3_ENDPOINT: "https://user:password@s3.example" }), "worker")
    ).toThrow("PLATFORM_CONFIG_INVALID:PDF_APPROVAL_STORAGE_S3_ENDPOINT");
  });

  it("rejects configuration for both storage backends", () => {
    expect(() =>
      loadPlatformConfig(workerEnv({ PDF_APPROVAL_STORAGE_FILESYSTEM_ROOT: filesystemRoot }), "worker")
    ).toThrow("PLATFORM_CONFIG_INVALID:PDF_APPROVAL_STORAGE_DRIVER");
    expect(() =>
      loadPlatformConfig(
        webEnv({
          PDF_APPROVAL_STORAGE_S3_ENDPOINT: "https://s3.example",
          PDF_APPROVAL_STORAGE_S3_REGION: "eu-west-1",
          PDF_APPROVAL_STORAGE_S3_BUCKET: "bucket",
          PDF_APPROVAL_STORAGE_S3_ACCESS_KEY: "access",
          PDF_APPROVAL_STORAGE_S3_SECRET_KEY: "secret",
          PDF_APPROVAL_STORAGE_S3_FORCE_PATH_STYLE: "false"
        }),
        "web"
      )
    ).toThrow("PLATFORM_CONFIG_INVALID:PDF_APPROVAL_STORAGE_DRIVER");
  });
});

describe("web security validation", () => {
  it.each([
    ["0", false],
    ["1", 1],
    ["5", 5],
    ["loopback", "loopback"]
  ] as const)("accepts controlled trusted proxy value %s", (value, expected) => {
    expect(loadPlatformConfig(webEnv({ PDF_APPROVAL_TRUST_PROXY: value }), "web").trustedProxy).toBe(expected);
  });

  it.each(["true", "6", "10.0.0.0/8", "proxy.example"])("rejects unsafe trusted proxy value %s", (value) => {
    expect(() => loadPlatformConfig(webEnv({ PDF_APPROVAL_TRUST_PROXY: value }), "web")).toThrow(
      "PLATFORM_CONFIG_INVALID:PDF_APPROVAL_TRUST_PROXY"
    );
  });

  it.each([
    "ftp://app.example",
    "https://user:password@app.example",
    "https://app.example/path?token=secret",
    "https://app.example/path#fragment"
  ])("rejects invalid public base URL %s", (value) => {
    expect(() => loadPlatformConfig(webEnv({ PDF_APPROVAL_PUBLIC_BASE_URL: value }), "web")).toThrow(
      "PLATFORM_CONFIG_INVALID:PDF_APPROVAL_PUBLIC_BASE_URL"
    );
  });

  it("enforces the session lifetime relationships", () => {
    expect(() =>
      loadPlatformConfig(
        webEnv({
          PDF_APPROVAL_SESSION_IDLE_TTL_MS: "60000",
          PDF_APPROVAL_SESSION_TOUCH_INTERVAL_MS: "60001"
        }),
        "web"
      )
    ).toThrow("PLATFORM_CONFIG_INVALID:PDF_APPROVAL_SESSION_TOUCH_INTERVAL_MS");
    expect(() =>
      loadPlatformConfig(webEnv({ PDF_APPROVAL_SESSION_ABSOLUTE_TTL_MS: "3000000" }), "web")
    ).toThrow("PLATFORM_CONFIG_INVALID:PDF_APPROVAL_SESSION_IDLE_TTL_MS");
  });
});

describe("versioned keyring validation", () => {
  it("rejects malformed JSON outside the local-only development shorthand", () => {
    expect(() => loadPlatformConfig(webEnv({ PDF_APPROVAL_TOTP_KEYRING: "not-json" }), "web")).toThrow(
      "PLATFORM_CONFIG_INVALID:PDF_APPROVAL_TOTP_KEYRING"
    );
  });

  it("rejects a current version that is absent", () => {
    expect(() =>
      loadPlatformConfig(webEnv({ PDF_APPROVAL_TOTP_KEYRING: keyring(1, "v2") }), "web")
    ).toThrow("PLATFORM_CONFIG_INVALID:PDF_APPROVAL_TOTP_KEYRING");
  });

  it("rejects key material shorter than 32 bytes", () => {
    const short = JSON.stringify({ currentVersion: "v1", keys: { v1: Buffer.alloc(31, 1).toString("base64") } });
    expect(() => loadPlatformConfig(webEnv({ PDF_APPROVAL_TOTP_KEYRING: short }), "web")).toThrow(
      "PLATFORM_CONFIG_INVALID:PDF_APPROVAL_TOTP_KEYRING"
    );
  });

  it("rejects duplicate key material inside one keyring", () => {
    const duplicate = keyring(1, "v1", { v2: Buffer.alloc(32, 1).toString("base64") });
    expect(() => loadPlatformConfig(webEnv({ PDF_APPROVAL_TOTP_KEYRING: duplicate }), "web")).toThrow(
      "PLATFORM_CONFIG_INVALID:PDF_APPROVAL_TOTP_KEYRING"
    );
  });

  it("rejects key material reused across purposes", () => {
    expect(() =>
      loadPlatformConfig(webEnv({ PDF_APPROVAL_INVITATION_HMAC_KEYRING: keyring(1) }), "web")
    ).toThrow("PLATFORM_CONFIG_INVALID:KEYRING_MATERIAL_REUSED");
  });

  it("supports distinct local-only shorthand values outside production", () => {
    const config = loadPlatformConfig(
      webEnv({
        PDF_APPROVAL_TOTP_KEYRING: "local-only-task-3-totp-keyring",
        PDF_APPROVAL_INVITATION_HMAC_KEYRING: "local-only-task-3-invitation-keyring",
        PDF_APPROVAL_RECOVERY_HMAC_KEYRING: "local-only-task-3-recovery-keyring",
        PDF_APPROVAL_CSRF_HMAC_KEYRING: "local-only-task-3-csrf-keyring"
      }),
      "web"
    );

    expect(config.keyrings.totpEncryption.keys.get("local-v1")).toHaveLength(32);
  });
});

describe("production security gates", () => {
  it("rejects local-only database credentials for every process", () => {
    expect(() =>
      loadPlatformConfig(
        {
          NODE_ENV: "production",
          PDF_APPROVAL_PLATFORM_MIGRATION_DATABASE_URL:
            "postgresql://platform_migration:local-only-password@db.example/platform"
        },
        "migration"
      )
    ).toThrow("INSECURE_PRODUCTION_CONFIG:PDF_APPROVAL_PLATFORM_MIGRATION_DATABASE_URL");
  });

  it("rejects insecure web cookie and HTTP base URL", () => {
    expect(() => loadPlatformConfig(webEnv({ NODE_ENV: "production" }), "web")).toThrow(
      "INSECURE_PRODUCTION_CONFIG:PDF_APPROVAL_COOKIE_SECURE"
    );
    expect(() =>
      loadPlatformConfig(
        webEnv({ NODE_ENV: "production", PDF_APPROVAL_COOKIE_SECURE: "true" }),
        "web"
      )
    ).toThrow("INSECURE_PRODUCTION_CONFIG:PDF_APPROVAL_PUBLIC_BASE_URL");
  });

  it("rejects default or local-only key material in production", () => {
    const defaultMaterial = Buffer.from("change-this-before-production-0000").toString("base64");
    const unsafe = JSON.stringify({ currentVersion: "v1", keys: { v1: defaultMaterial } });
    expect(() =>
      loadPlatformConfig(
        webEnv({
          NODE_ENV: "production",
          PDF_APPROVAL_COOKIE_SECURE: "true",
          PDF_APPROVAL_PUBLIC_BASE_URL: "https://approval.example",
          PDF_APPROVAL_TOTP_KEYRING: unsafe
        }),
        "web"
      )
    ).toThrow("INSECURE_PRODUCTION_CONFIG:PDF_APPROVAL_TOTP_KEYRING");
  });

  it("rejects Mailpit and unauthenticated SMTP in production", () => {
    expect(() =>
      loadPlatformConfig(workerEnv({ NODE_ENV: "production" }), "worker")
    ).toThrow("INSECURE_PRODUCTION_CONFIG:PDF_APPROVAL_SMTP_HOST");
    expect(() =>
      loadPlatformConfig(
        workerEnv({
          NODE_ENV: "production",
          PDF_APPROVAL_SMTP_HOST: "smtp.example",
          PDF_APPROVAL_SMTP_PORT: "465",
          PDF_APPROVAL_SMTP_SECURE: "true"
        }),
        "worker"
      )
    ).toThrow("INSECURE_PRODUCTION_CONFIG:PDF_APPROVAL_SMTP_USER");
  });

  it("rejects local S3 endpoint and credentials in production", () => {
    expect(() =>
      loadPlatformConfig(
        workerEnv({
          NODE_ENV: "production",
          PDF_APPROVAL_SMTP_HOST: "smtp.example",
          PDF_APPROVAL_SMTP_PORT: "465",
          PDF_APPROVAL_SMTP_SECURE: "true",
          PDF_APPROVAL_SMTP_USER: "mailer",
          PDF_APPROVAL_SMTP_PASSWORD: "strong-smtp-password"
        }),
        "worker"
      )
    ).toThrow("INSECURE_PRODUCTION_CONFIG:PDF_APPROVAL_STORAGE_S3_ENDPOINT");
  });

  it("enforces minimum S3 credential lengths in production", () => {
    const productionOverrides = {
      NODE_ENV: "production",
      PDF_APPROVAL_SMTP_HOST: "smtp.example",
      PDF_APPROVAL_SMTP_PORT: "465",
      PDF_APPROVAL_SMTP_SECURE: "true",
      PDF_APPROVAL_SMTP_USER: "mailer",
      PDF_APPROVAL_SMTP_PASSWORD: "strong-smtp-password",
      PDF_APPROVAL_STORAGE_S3_ENDPOINT: "https://s3.example"
    };

    expect(() =>
      loadPlatformConfig(
        workerEnv({
          ...productionOverrides,
          PDF_APPROVAL_STORAGE_S3_ACCESS_KEY: "1234567",
          PDF_APPROVAL_STORAGE_S3_SECRET_KEY: "1234567890abcdef"
        }),
        "worker"
      )
    ).toThrow("INSECURE_PRODUCTION_CONFIG:PDF_APPROVAL_STORAGE_S3_ACCESS_KEY");
    expect(() =>
      loadPlatformConfig(
        workerEnv({
          ...productionOverrides,
          PDF_APPROVAL_STORAGE_S3_ACCESS_KEY: "12345678",
          PDF_APPROVAL_STORAGE_S3_SECRET_KEY: "1234567890abcde"
        }),
        "worker"
      )
    ).toThrow("INSECURE_PRODUCTION_CONFIG:PDF_APPROVAL_STORAGE_S3_SECRET_KEY");
    expect(() =>
      loadPlatformConfig(
        workerEnv({
          ...productionOverrides,
          PDF_APPROVAL_STORAGE_S3_ACCESS_KEY: "12345678",
          PDF_APPROVAL_STORAGE_S3_SECRET_KEY: "1234567890abcdef"
        }),
        "worker"
      )
    ).not.toThrow();
  });
});
