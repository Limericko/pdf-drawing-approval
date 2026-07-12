export type PlatformProcessTarget = "web" | "worker" | "migration" | "bootstrap-admin";
export type PlatformEnvironment = "development" | "test" | "production";
export type PlatformConfigErrorCode = "PLATFORM_CONFIG_INVALID" | "INSECURE_PRODUCTION_CONFIG";

export class PlatformConfigError extends Error {
  constructor(
    readonly code: PlatformConfigErrorCode,
    readonly field: string
  ) {
    super(`${code}:${field}`);
    this.name = "PlatformConfigError";
  }
}

export type PlatformDatabaseConfig = {
  connectionString: string;
  poolMax: number;
  connectTimeoutMs: number;
  queryTimeoutMs: number;
  lockTimeoutMs: number;
  transactionTimeoutMs: number;
};

export type VersionedKeyring = {
  currentVersion: string;
  keys: Map<string, Buffer>;
};

export type FilesystemStorageConfig = {
  driver: "filesystem";
  root: string;
};

export type S3StorageConfig = {
  driver: "s3";
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  forcePathStyle: boolean;
};

export type PlatformStorageConfig = FilesystemStorageConfig | S3StorageConfig;
export type TrustedProxyConfig = false | 1 | 2 | 3 | 4 | 5 | "loopback";

export type PlatformSessionConfig = {
  cookieSecure: boolean;
  absoluteTtlMs: number;
  idleTtlMs: number;
  touchIntervalMs: number;
};

export type PlatformSmtpConfig = {
  host: string;
  port: number;
  from: string;
  secure: boolean;
  requireTls: boolean;
  username: string | undefined;
  password: string | undefined;
};

export type PlatformWorkerConfig = {
  concurrency: number;
  leaseMs: number;
  maxAttempts: number;
  retryBaseMs: number;
  retryMaxMs: number;
  storageCleanupReapIntervalMs: number;
};

type BasePlatformConfig<TTarget extends PlatformProcessTarget> = {
  target: TTarget;
  environment: PlatformEnvironment;
  database: PlatformDatabaseConfig;
};

export type WebPlatformConfig = BasePlatformConfig<"web"> & {
  storage: PlatformStorageConfig;
  publicBaseUrl: string;
  trustedProxy: TrustedProxyConfig;
  session: PlatformSessionConfig;
  keyrings: {
    totpEncryption: VersionedKeyring;
    invitationHmac: VersionedKeyring;
    recoveryHmac: VersionedKeyring;
    csrfHmac: VersionedKeyring;
  };
};

export type WorkerPlatformConfig = BasePlatformConfig<"worker"> & {
  storage: PlatformStorageConfig;
  smtp: PlatformSmtpConfig;
  worker: PlatformWorkerConfig;
  keyrings: {
    invitationHmac: VersionedKeyring;
  };
};

export type MigrationPlatformConfig = BasePlatformConfig<"migration">;

export type BootstrapPlatformConfig = BasePlatformConfig<"bootstrap-admin"> & {
  keyrings: {
    totpEncryption: VersionedKeyring;
    recoveryHmac: VersionedKeyring;
  };
};

export type PlatformConfig =
  | WebPlatformConfig
  | WorkerPlatformConfig
  | MigrationPlatformConfig
  | BootstrapPlatformConfig;
