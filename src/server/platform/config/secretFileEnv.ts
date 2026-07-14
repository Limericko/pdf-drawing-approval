import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { PlatformConfigError, type PlatformProcessTarget } from "./types.ts";

const MAX_SECRET_FILE_BYTES = 64 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true });

const commonStorageSecrets = [
  "PDF_APPROVAL_STORAGE_S3_ACCESS_KEY",
  "PDF_APPROVAL_STORAGE_S3_SECRET_KEY"
] as const;

const secretFields: Readonly<Record<PlatformProcessTarget, readonly string[]>> = Object.freeze({
  web: Object.freeze([
    "PDF_APPROVAL_PLATFORM_WEB_DATABASE_URL",
    ...commonStorageSecrets,
    "PDF_APPROVAL_TOTP_KEYRING",
    "PDF_APPROVAL_INVITATION_HMAC_KEYRING",
    "PDF_APPROVAL_RECOVERY_HMAC_KEYRING",
    "PDF_APPROVAL_CSRF_HMAC_KEYRING"
  ]),
  worker: Object.freeze([
    "PDF_APPROVAL_PLATFORM_WORKER_DATABASE_URL",
    ...commonStorageSecrets,
    "PDF_APPROVAL_SMTP_PASSWORD",
    "PDF_APPROVAL_INVITATION_HMAC_KEYRING"
  ]),
  migration: Object.freeze(["PDF_APPROVAL_PLATFORM_MIGRATION_DATABASE_URL"]),
  "bootstrap-admin": Object.freeze([
    "PDF_APPROVAL_PLATFORM_BOOTSTRAP_DATABASE_URL",
    "PDF_APPROVAL_TOTP_KEYRING",
    "PDF_APPROVAL_RECOVERY_HMAC_KEYRING"
  ])
});

export function resolveSecretFileEnvironment(
  env: NodeJS.ProcessEnv,
  target: PlatformProcessTarget
): NodeJS.ProcessEnv {
  const resolved = { ...env };
  for (const field of secretFields[target]) {
    const fileField = `${field}_FILE`;
    if (env[fileField] === undefined) continue;
    if (env[field] !== undefined) invalid(fileField);
    const configuredPath = env[fileField];
    if (!configuredPath || configuredPath !== configuredPath.trim() || !path.isAbsolute(configuredPath)) {
      invalid(fileField);
    }
    resolved[field] = readSecretFile(configuredPath, fileField, env.NODE_ENV === "production");
  }
  return resolved;
}

function readSecretFile(filePath: string, field: string, production: boolean) {
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(filePath);
  } catch {
    invalid(field);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > MAX_SECRET_FILE_BYTES) {
    invalid(field);
  }
  if (production && process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    insecure(field);
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(filePath);
  } catch {
    invalid(field);
  }
  if (bytes.byteLength <= 0 || bytes.byteLength > MAX_SECRET_FILE_BYTES || bytes.includes(0)) invalid(field);

  let value: string;
  try {
    value = utf8.decode(bytes);
  } catch {
    invalid(field);
  }
  if (value.endsWith("\r\n")) value = value.slice(0, -2);
  else if (value.endsWith("\n")) value = value.slice(0, -1);
  if (!value || value.includes("\u0000")) invalid(field);
  return value;
}

function invalid(field: string): never {
  throw new PlatformConfigError("PLATFORM_CONFIG_INVALID", field);
}

function insecure(field: string): never {
  throw new PlatformConfigError("INSECURE_PRODUCTION_CONFIG", field);
}
