import { createHash } from "node:crypto";
import { Secret, TOTP } from "otpauth";
import { z } from "zod";
import { v7 as uuidv7 } from "uuid";
import type { PlatformPool } from "../../platform/database/pool.ts";
import { withTransaction } from "../../platform/database/transaction.ts";
import { PostgresOutboxPublisher } from "../../platform/jobs/outboxPublisher.ts";
import { hashPassword, type Argon2idOptions } from "../../platform/security/passwords.ts";
import { generateRecoveryCodes, hashRecoveryCode } from "../../platform/security/recoveryCodes.ts";
import { decryptSecret, encryptSecret } from "../../platform/security/secretEncryption.ts";
import {
  createInvitationToken, generateOpaqueToken, hashOpaqueToken, invitationIdFromToken,
  verifyInvitationToken, verifyOpaqueToken
} from "../../platform/security/tokenHash.ts";
import { generateTotpSecret, verifyTotp } from "../../platform/security/totp.ts";
import type { VersionedKeyring } from "../../platform/config/types.ts";
import type { PlatformRole, ProjectMemberRole } from "./models.ts";
import { normalizeEmail } from "./email.ts";
import { PostgresAuditRepository } from "./repositories/postgres/PostgresAuditRepository.ts";
import { PostgresInvitationRepository } from "./repositories/postgres/PostgresInvitationRepository.ts";
import { PostgresMfaRepository } from "./repositories/postgres/PostgresMfaRepository.ts";
import { PostgresProjectRepository } from "./repositories/postgres/PostgresProjectRepository.ts";
import { PostgresRateLimitRepository } from "./repositories/postgres/PostgresRateLimitRepository.ts";
import { PostgresUserRepository } from "./repositories/postgres/PostgresUserRepository.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const emailSchema = z.string().max(254).email();
const projectRoles = new Set<ProjectMemberRole>(["manager", "designer", "supervisor", "process", "viewer"]);
const ENROLLMENT_LIFETIME_SECONDS = 10 * 60;
const ENROLLMENT_MAX_ATTEMPTS = 5;
const RATE_LIMIT_POLICY = { windowSeconds: 15 * 60, limit: 10, blockSeconds: 15 * 60 } as const;

export class InvitationServiceError extends Error {
  constructor(readonly code: "INVITATION_INVALID" | "INVITATION_RATE_LIMITED" | "INVITATION_PASSWORD_POLICY" | "INVITATION_TOTP_INVALID") {
    super(code); this.name = "InvitationServiceError";
  }
}

type Keyrings = {
  invitationHmac: VersionedKeyring;
  totpEncryption: VersionedKeyring;
  recoveryHmac: VersionedKeyring;
};

type Options = {
  readonly pool: PlatformPool;
  readonly keyrings: Keyrings;
  readonly passwordHashOptions: Argon2idOptions;
  readonly generateTotpSecret?: () => Buffer;
  readonly generateRecoveryCodes?: () => string[];
  readonly generateOpaqueToken?: () => string;
  readonly hashPassword?: typeof hashPassword;
  readonly verifyTotp?: typeof verifyTotp;
};

export function createInvitationService(options: Options) {
  const makeTotpSecret = options.generateTotpSecret ?? generateTotpSecret;
  const makeRecoveryCodes = options.generateRecoveryCodes ?? generateRecoveryCodes;
  const makeOpaqueToken = options.generateOpaqueToken ?? generateOpaqueToken;
  const passwordHasher = options.hashPassword ?? hashPassword;
  const totpVerifier = options.verifyTotp ?? verifyTotp;
  const outbox = new PostgresOutboxPublisher({ createId: uuidv7, clock: () => new Date() });

  return Object.freeze({
    async createInvitation(input: {
      readonly email: string; readonly platformRole: PlatformRole; readonly projectId: string;
      readonly projectRole: ProjectMemberRole; readonly invitedByUserId: string;
    }) {
      const owned = ownCreate(input);
      const invitationId = uuidv7();
      const createdToken = createInvitationToken(invitationId, options.keyrings.invitationHmac);
      await withTransaction(options.pool, async (tx) => {
        const project = await new PostgresProjectRepository(tx).findByIdForMember(owned.projectId, owned.invitedByUserId);
        if (!project || project.status !== "active") throw invalid();
        await new PostgresInvitationRepository(tx).create({
          id: invitationId,
          tokenHash: createdToken.record.tokenHash,
          tokenKeyVersion: createdToken.record.keyVersion,
          email: owned.email,
          platformRole: owned.platformRole,
          projectId: owned.projectId,
          projectRole: owned.projectRole,
          invitedByUserId: owned.invitedByUserId
        });
        await new PostgresAuditRepository(tx).append({
          actorUserId: owned.invitedByUserId, actorType: "user", action: "invitation.create",
          targetType: "invitation", targetId: invitationId, requestId: `invitation-create:${invitationId}`,
          result: "success", metadata: { projectId: owned.projectId }
        });
        await outbox.publish(tx, { eventType: "invitation.created", payloadVersion: 1, payload: { invitationId } });
      });
      return Object.freeze({ invitationId, token: createdToken.token });
    },

    async prepare(input: { readonly invitationToken: string; readonly sourceIpPrefix: string }) {
      const invitationId = invitationIdFromToken(input?.invitationToken);
      if (!invitationId) throw invalid();
      const presentedHash = hashOpaqueToken(input.invitationToken);
      await enforceRateLimit(options.pool, input.sourceIpPrefix, presentedHash);
      const invitation = await new PostgresInvitationRepository(options.pool).findActiveById(invitationId);
      if (!invitation) throw invalid();
      try {
        verifyInvitationToken(input.invitationToken, {
          invitationId: invitation.id, keyVersion: invitation.tokenKeyVersion, tokenHash: invitation.tokenHash
        }, options.keyrings.invitationHmac);
      } catch {
        throw invalid();
      }

      const enrollmentToken = makeOpaqueToken();
      const enrollmentHash = hashOpaqueToken(enrollmentToken);
      let secret = Buffer.from(makeTotpSecret());
      const encrypted = encryptSecret(secret, options.keyrings.totpEncryption);
      const otpauthUri = createOtpAuthUri(secret, invitation.emailNormalized);
      try {
        await withTransaction(options.pool, async (tx) => {
          const mfa = new PostgresMfaRepository(tx);
          if (!await mfa.lockActiveInvitationForEnrollment(invitation.id)) throw invalid();
          await mfa.invalidateOpenEnrollmentsForInvitation(invitation.id);
          await mfa.createEnrollment({ invitationId: invitation.id, tokenHash: enrollmentHash,
            encryptedTotpSecret: encrypted.encryptedSecret, keyVersion: encrypted.keyVersion,
            lifetimeSeconds: ENROLLMENT_LIFETIME_SECONDS, maxAttempts: ENROLLMENT_MAX_ATTEMPTS });
        });
        return Object.freeze({ enrollmentToken, otpauthUri });
      } finally {
        secret.fill(0); secret = Buffer.alloc(0); encrypted.encryptedSecret.fill(0); enrollmentHash.fill(0);
      }
    },

    async complete(input: { readonly enrollmentToken: string; readonly sourceIpPrefix: string; readonly password: string; readonly totp: string }) {
      const enrollmentHash = hashOpaqueToken(input?.enrollmentToken ?? "");
      const initialMfa = new PostgresMfaRepository(options.pool);
      const initialEnrollment = await initialMfa.findActiveEnrollmentByTokenHash(enrollmentHash);
      if (!initialEnrollment) throw invalid();
      const initialInvitation = await new PostgresInvitationRepository(options.pool).findById(initialEnrollment.invitationId);
      if (!initialInvitation) throw invalid();
      await enforceRateLimit(options.pool, input.sourceIpPrefix, initialInvitation.tokenHash);
      ownPassword(input.password);
      const passwordHash = await passwordHasher(input.password, options.passwordHashOptions);
      let secret = decryptSecret({ encryptedSecret: initialEnrollment.encryptedTotpSecret, keyVersion: initialEnrollment.keyVersion }, options.keyrings.totpEncryption);
      const recoveryHashes: ReturnType<typeof hashRecoveryCode>[] = [];
      try {
        if (!totpVerifier(secret, input.totp, Date.now())) {
          await initialMfa.recordEnrollmentAttempt(initialEnrollment.id);
          throw new InvitationServiceError("INVITATION_TOTP_INVALID");
        }
        const recoveryCodes = makeRecoveryCodes();
        if (recoveryCodes.length !== 10 || new Set(recoveryCodes).size !== 10) throw invalid();
        for (const code of recoveryCodes) recoveryHashes.push(hashRecoveryCode(code, options.keyrings.recoveryHmac));
        await withTransaction(options.pool, async (tx) => {
          const mfa = new PostgresMfaRepository(tx);
          if (!await mfa.lockActiveInvitationForEnrollment(initialInvitation.id)) throw invalid();
          const enrollment = await mfa.lockActiveEnrollmentByTokenHash(enrollmentHash);
          if (!enrollment || enrollment.id !== initialEnrollment.id || !verifyOpaqueToken(input.enrollmentToken, enrollment.tokenHash)) throw invalid();
          const invitation = await new PostgresInvitationRepository(tx).findActiveById(initialInvitation.id);
          if (!invitation) throw invalid();
          const nowResult = await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now");
          const confirmedAt = nowResult.rows[0]!.now;
          const user = await new PostgresUserRepository(tx).create({ email: invitation.emailNormalized,
            displayName: invitation.emailNormalized.split("@")[0]!, passwordHash,
            platformRole: invitation.platformRole, status: "active", mfaEnabledAt: confirmedAt });
          await mfa.insertTotpCredential({ userId: user.id, encryptedSecret: enrollment.encryptedTotpSecret,
            keyVersion: enrollment.keyVersion, confirmedAt });
          await mfa.insertRecoveryCodes(user.id, recoveryHashes);
          await new PostgresProjectRepository(tx).addMember({ projectId: invitation.projectId, userId: user.id,
            role: invitation.projectRole, status: "active" });
          if (!await mfa.completeEnrollment(enrollment.id)) throw invalid();
          if (!await new PostgresInvitationRepository(tx).consume(invitation.id, user.id)) throw invalid();
          await new PostgresAuditRepository(tx).append({ actorUserId: user.id, actorType: "user",
            action: "invitation.accept", targetType: "invitation", targetId: invitation.id,
            requestId: `invitation-accept:${invitation.id}`, result: "success", metadata: { projectId: invitation.projectId, mfaMethod: "totp" } });
        });
        return Object.freeze({ recoveryCodes: [...recoveryCodes] });
      } finally {
        secret.fill(0); enrollmentHash.fill(0); for (const item of recoveryHashes) item.hash.fill(0);
      }
    }
  });
}

async function enforceRateLimit(pool: PlatformPool, sourceIpPrefix: string, accountKey: Buffer) {
  if (typeof sourceIpPrefix !== "string" || !sourceIpPrefix || sourceIpPrefix.length > 128 || /[\r\n\0]/.test(sourceIpPrefix)) throw invalid();
  const ipKey = createHash("sha256").update("invitation-ip\0").update(sourceIpPrefix).digest();
  const blocked = await withTransaction(pool, async (tx) => {
    const repo = new PostgresRateLimitRepository(tx);
    const ip = await repo.increment({ bucketType: "ip-prefix", bucketKey: ipKey, ...RATE_LIMIT_POLICY });
    const account = await repo.increment({ bucketType: "account", bucketKey: Buffer.from(accountKey), ...RATE_LIMIT_POLICY });
    return ip.blocked || account.blocked;
  });
  if (blocked) throw new InvitationServiceError("INVITATION_RATE_LIMITED");
}

function ownCreate(input: { email: string; platformRole: PlatformRole; projectId: string; projectRole: ProjectMemberRole; invitedByUserId: string }) {
  const email = normalizeEmail(input?.email ?? "");
  if (!emailSchema.safeParse(email).success || !UUID.test(input?.projectId) || !UUID.test(input?.invitedByUserId) ||
      !["admin", "member"].includes(input?.platformRole) || !projectRoles.has(input?.projectRole)) throw invalid();
  return { ...input, email };
}

function ownPassword(value: unknown) {
  if (typeof value !== "string" || Buffer.byteLength(value) < 12 || Buffer.byteLength(value) > 256 || value.includes("\0")) {
    throw new InvitationServiceError("INVITATION_PASSWORD_POLICY");
  }
}

function createOtpAuthUri(secret: Buffer, accountName: string) {
  const copy = Uint8Array.from(secret);
  return new TOTP({ issuer: "PDF Approval", label: accountName, digits: 6, period: 30,
    algorithm: "SHA1", secret: new Secret({ buffer: copy.buffer }) }).toString();
}

function invalid() { return new InvitationServiceError("INVITATION_INVALID"); }
