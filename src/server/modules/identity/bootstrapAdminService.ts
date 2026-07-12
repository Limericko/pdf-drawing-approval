import { Secret, TOTP } from "otpauth";
import { z } from "zod";
import type { BootstrapPlatformConfig } from "../../platform/config/types.ts";
import type { PlatformPool } from "../../platform/database/pool.ts";
import { withTransaction } from "../../platform/database/transaction.ts";
import { hashPassword, type Argon2idOptions } from "../../platform/security/passwords.ts";
import { generateRecoveryCodes, hashRecoveryCode } from "../../platform/security/recoveryCodes.ts";
import { encryptSecret } from "../../platform/security/secretEncryption.ts";
import { generateTotpSecret, verifyTotp } from "../../platform/security/totp.ts";
import { normalizeEmail } from "./email.ts";
import { PostgresAuditRepository } from "./repositories/postgres/PostgresAuditRepository.ts";
import { PostgresMfaRepository } from "./repositories/postgres/PostgresMfaRepository.ts";
import { PostgresUserRepository } from "./repositories/postgres/PostgresUserRepository.ts";

const BOOTSTRAP_ADVISORY_LOCK_ID = 1_347_696_961;
const MIN_PASSWORD_BYTES = 12;
const MAX_PASSWORD_BYTES = 256;
const DISPLAY_NAME_MAX_CHARACTERS = 200;
const emailSchema = z.string().max(254).email();

export type BootstrapAdminErrorCode =
  | "BOOTSTRAP_ADMIN_INPUT_INVALID"
  | "BOOTSTRAP_ADMIN_PASSWORD_POLICY"
  | "BOOTSTRAP_ADMIN_TOTP_INVALID"
  | "BOOTSTRAP_ADMIN_ALREADY_EXISTS"
  | "BOOTSTRAP_ADMIN_CHALLENGE_USED";

export class BootstrapAdminError extends Error {
  constructor(readonly code: BootstrapAdminErrorCode) {
    super(code);
    this.name = "BootstrapAdminError";
  }
}

export type BootstrapAdminChallenge = {
  readonly otpauthUri: string;
  complete(token: string): Promise<{ readonly recoveryCodes: readonly string[] }>;
};

type Options = {
  readonly pool: PlatformPool;
  readonly keyrings: BootstrapPlatformConfig["keyrings"];
  readonly passwordHashOptions: Argon2idOptions;
  readonly clock?: () => Date;
  readonly generateTotpSecret?: () => Buffer;
  readonly generateRecoveryCodes?: () => string[];
};

export function createBootstrapAdminService(options: Options) {
  if (!options?.pool || !options.keyrings || !options.passwordHashOptions) {
    throw new BootstrapAdminError("BOOTSTRAP_ADMIN_INPUT_INVALID");
  }
  const clock = options.clock ?? (() => new Date());
  const createTotpSecret = options.generateTotpSecret ?? generateTotpSecret;
  const createRecoveryCodes = options.generateRecoveryCodes ?? generateRecoveryCodes;

  return Object.freeze({
    async prepare(input: { readonly email: string; readonly displayName: string; readonly password: string }) {
      const email = ownEmail(input?.email);
      const displayName = ownDisplayName(input?.displayName);
      let password = ownPassword(input?.password);
      let passwordHash = "";
      let secret = Buffer.alloc(0);
      let encryptedSecret = Buffer.alloc(0);
      let encryptionKeyVersion = "";
      let recoveryCodes: string[] = [];
      let recoveryHashes: Array<{ keyVersion: string; hash: Buffer }> = [];
      let uri = "";
      try {
        passwordHash = await hashPassword(password, options.passwordHashOptions);
        password = "";
        secret = Buffer.from(createTotpSecret());
        const encrypted = encryptSecret(secret, options.keyrings.totpEncryption);
        encryptedSecret = Buffer.from(encrypted.encryptedSecret);
        encryptionKeyVersion = encrypted.keyVersion;
        recoveryCodes = createRecoveryCodes();
        if (recoveryCodes.length !== 10 || new Set(recoveryCodes).size !== 10) {
          throw new BootstrapAdminError("BOOTSTRAP_ADMIN_INPUT_INVALID");
        }
        recoveryHashes = recoveryCodes.map((code) => hashRecoveryCode(code, options.keyrings.recoveryHmac));
        uri = createOtpAuthUri(secret, email);
        let consumed = false;

        const challenge: BootstrapAdminChallenge = Object.freeze({
        get otpauthUri() {
          return uri;
        },
        async complete(token: string) {
          if (consumed) throw new BootstrapAdminError("BOOTSTRAP_ADMIN_CHALLENGE_USED");
          consumed = true;
          try {
            const verificationTime = ownClock(clock());
            if (!verifyTotp(secret, token, verificationTime.getTime())) {
              throw new BootstrapAdminError("BOOTSTRAP_ADMIN_TOTP_INVALID");
            }
            const result = await withTransaction(options.pool, async (transaction) => {
              await transaction.query("SELECT pg_advisory_xact_lock($1)", [BOOTSTRAP_ADVISORY_LOCK_ID]);
              const existing = await transaction.query<{ exists: boolean }>(
                "SELECT EXISTS (SELECT 1 FROM platform.users) AS exists"
              );
              if (existing.rows[0]?.exists !== false) {
                throw new BootstrapAdminError("BOOTSTRAP_ADMIN_ALREADY_EXISTS");
              }
              const databaseTime = await transaction.query<{ now: Date }>(
                "SELECT clock_timestamp() AS now"
              );
              const confirmedAt = databaseTime.rows[0]?.now;
              if (!(confirmedAt instanceof Date) || !Number.isFinite(confirmedAt.getTime())) {
                throw new BootstrapAdminError("BOOTSTRAP_ADMIN_INPUT_INVALID");
              }
              const users = new PostgresUserRepository(transaction);
              const mfa = new PostgresMfaRepository(transaction);
              const audit = new PostgresAuditRepository(transaction);
              const user = await users.create({
                email,
                displayName,
                passwordHash,
                platformRole: "admin",
                status: "active",
                mfaEnabledAt: confirmedAt
              });
              await mfa.insertTotpCredential({
                userId: user.id,
                encryptedSecret,
                keyVersion: encryptionKeyVersion,
                confirmedAt
              });
              await mfa.insertRecoveryCodes(user.id, recoveryHashes);
              await audit.appendOnly({
                actorUserId: user.id,
                actorType: "bootstrap",
                action: "admin.bootstrap",
                targetType: "user",
                targetId: user.id,
                requestId: `bootstrap-admin:${user.id}`,
                result: "success",
                metadata: { mfaMethod: "totp" }
              });
              return { recoveryCodes: [...recoveryCodes] } as const;
            });
            return result;
          } finally {
            clearSensitive(secret, encryptedSecret, ...recoveryHashes.map(({ hash }) => hash));
            secret = Buffer.alloc(0);
            encryptedSecret = Buffer.alloc(0);
            recoveryHashes = [];
            recoveryCodes = [];
            passwordHash = "";
            uri = "";
          }
        }
        });
        return challenge;
      } catch (error) {
        password = "";
        passwordHash = "";
        clearSensitive(secret, encryptedSecret, ...recoveryHashes.map(({ hash }) => hash));
        secret = Buffer.alloc(0);
        encryptedSecret = Buffer.alloc(0);
        encryptionKeyVersion = "";
        recoveryHashes = [];
        recoveryCodes = [];
        uri = "";
        throw error;
      }
    }
  });
}

function ownEmail(value: unknown) {
  if (typeof value !== "string") throw new BootstrapAdminError("BOOTSTRAP_ADMIN_INPUT_INVALID");
  const normalized = normalizeEmail(value);
  if (!emailSchema.safeParse(normalized).success) throw new BootstrapAdminError("BOOTSTRAP_ADMIN_INPUT_INVALID");
  return normalized;
}

function ownDisplayName(value: unknown) {
  if (typeof value !== "string") throw new BootstrapAdminError("BOOTSTRAP_ADMIN_INPUT_INVALID");
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > DISPLAY_NAME_MAX_CHARACTERS || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new BootstrapAdminError("BOOTSTRAP_ADMIN_INPUT_INVALID");
  }
  return normalized;
}

function ownPassword(value: unknown) {
  if (typeof value !== "string") throw new BootstrapAdminError("BOOTSTRAP_ADMIN_PASSWORD_POLICY");
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < MIN_PASSWORD_BYTES || bytes > MAX_PASSWORD_BYTES || value.includes("\0")) {
    throw new BootstrapAdminError("BOOTSTRAP_ADMIN_PASSWORD_POLICY");
  }
  return value;
}

function ownClock(value: Date) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new BootstrapAdminError("BOOTSTRAP_ADMIN_INPUT_INVALID");
  }
  return new Date(value.getTime());
}

function createOtpAuthUri(secret: Buffer, accountName: string) {
  const copied = Uint8Array.from(secret);
  const otpSecret = new Secret({ buffer: copied.buffer });
  return new TOTP({
    issuer: "PDF Approval",
    label: accountName,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: otpSecret
  }).toString();
}

function clearSensitive(...values: Buffer[]) {
  for (const value of values) value.fill(0);
}
