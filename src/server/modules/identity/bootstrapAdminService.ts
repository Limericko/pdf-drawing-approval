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
const DEFAULT_BOOTSTRAP_CHALLENGE_TTL_MS = 10 * 60 * 1000;
const emailSchema = z.string().max(254).email();

type ChallengeExpirationHandle = {
  cancel(): void;
};

type ChallengeExpirationScheduler = {
  schedule(callback: () => void, delayMs: number): ChallengeExpirationHandle;
};

const defaultChallengeExpirationScheduler: ChallengeExpirationScheduler = Object.freeze({
  schedule(callback: () => void, delayMs: number) {
    let active = true;
    const timer = setTimeout(() => {
      if (!active) return;
      active = false;
      callback();
    }, delayMs);
    timer.unref();
    return Object.freeze({
      cancel() {
        if (!active) return;
        active = false;
        clearTimeout(timer);
      }
    });
  }
});

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
  dispose(): void;
};

type Options = {
  readonly pool: PlatformPool;
  readonly keyrings: BootstrapPlatformConfig["keyrings"];
  readonly passwordHashOptions: Argon2idOptions;
  readonly clock?: () => Date;
  readonly generateTotpSecret?: () => Buffer;
  readonly generateRecoveryCodes?: () => string[];
  readonly encryptSecret?: typeof encryptSecret;
  readonly hashRecoveryCode?: typeof hashRecoveryCode;
  readonly challengeTtlMs?: number;
  readonly scheduler?: ChallengeExpirationScheduler;
};

export function createBootstrapAdminService(options: Options) {
  if (
    !options?.pool ||
    !options.keyrings ||
    !options.passwordHashOptions ||
    (options.challengeTtlMs !== undefined &&
      (!Number.isSafeInteger(options.challengeTtlMs) || options.challengeTtlMs <= 0))
  ) {
    throw new BootstrapAdminError("BOOTSTRAP_ADMIN_INPUT_INVALID");
  }
  const clock = options.clock ?? (() => new Date());
  const createTotpSecret = options.generateTotpSecret ?? generateTotpSecret;
  const createRecoveryCodes = options.generateRecoveryCodes ?? generateRecoveryCodes;
  const encryptTotpSecret = options.encryptSecret ?? encryptSecret;
  const createRecoveryHash = options.hashRecoveryCode ?? hashRecoveryCode;
  const challengeTtlMs = options.challengeTtlMs ?? DEFAULT_BOOTSTRAP_CHALLENGE_TTL_MS;
  const scheduler = options.scheduler ?? defaultChallengeExpirationScheduler;

  return Object.freeze({
    async prepare(input: { readonly email: string; readonly displayName: string; readonly password: string }) {
      let email = ownEmail(input?.email);
      let displayName = ownDisplayName(input?.displayName);
      let password = ownPassword(input?.password);
      let passwordHash = "";
      let secret: Buffer = Buffer.alloc(0);
      let encryptedSecret: Buffer = Buffer.alloc(0);
      let encryptionKeyVersion = "";
      let recoveryCodes: string[] = [];
      let recoveryHashes: Array<{ keyVersion: string; hash: Buffer }> = [];
      let uri = "";
      let state: "active" | "completing" | "disposed" = "active";
      let expiration: ChallengeExpirationHandle | undefined;

      const cancelExpiration = () => {
        const currentExpiration = expiration;
        expiration = undefined;
        if (!currentExpiration) return;
        try {
          currentExpiration.cancel();
        } catch {
          // Expiration cancellation must never prevent deterministic secret wiping.
        }
      };
      const clearPreparedResources = () => {
        clearSensitive(secret, encryptedSecret, ...recoveryHashes.map(({ hash }) => hash));
        secret = Buffer.alloc(0);
        encryptedSecret = Buffer.alloc(0);
        recoveryHashes = [];
        recoveryCodes = [];
        email = "";
        displayName = "";
        password = "";
        passwordHash = "";
        encryptionKeyVersion = "";
        uri = "";
      };
      const dispose = () => {
        if (state !== "active") return;
        state = "disposed";
        cancelExpiration();
        clearPreparedResources();
      };

      try {
        passwordHash = await hashPassword(password, options.passwordHashOptions);
        password = "";
        secret = createTotpSecret();
        const encrypted = encryptTotpSecret(secret, options.keyrings.totpEncryption);
        encryptedSecret = encrypted.encryptedSecret;
        encryptionKeyVersion = encrypted.keyVersion;
        recoveryCodes = createRecoveryCodes();
        if (recoveryCodes.length !== 10 || new Set(recoveryCodes).size !== 10) {
          throw new BootstrapAdminError("BOOTSTRAP_ADMIN_INPUT_INVALID");
        }
        for (const code of recoveryCodes) {
          recoveryHashes.push(createRecoveryHash(code, options.keyrings.recoveryHmac));
        }
        uri = createOtpAuthUri(secret, email);

        const challenge: BootstrapAdminChallenge = Object.freeze({
          get otpauthUri() {
            return uri;
          },
          dispose,
          async complete(token: string) {
            if (state !== "active") throw new BootstrapAdminError("BOOTSTRAP_ADMIN_CHALLENGE_USED");
            state = "completing";
            cancelExpiration();
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
              state = "disposed";
              clearPreparedResources();
            }
          }
        });
        const scheduledExpiration = scheduler.schedule(dispose, challengeTtlMs);
        if (state === "active") {
          expiration = scheduledExpiration;
        } else {
          scheduledExpiration.cancel();
        }
        return challenge;
      } catch (error) {
        state = "disposed";
        cancelExpiration();
        clearPreparedResources();
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
