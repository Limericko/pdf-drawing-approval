import type { QueryResultRow } from "pg";
import type { QueryExecutor } from "../../../../platform/database/queryExecutor.ts";
import { createIdentityId } from "../../ids.ts";
import type {
  CreateMfaChallengeInput,
  CreateMfaEnrollmentInput,
  MfaChallenge,
  MfaEnrollment,
  MfaRepository,
  RecoveryCodeRecord,
  SaveTotpCredentialInput,
  TotpCredential
} from "../mfaRepository.ts";

type ChallengeRow = QueryResultRow & {
  id: string; user_id: string; token_hash: Buffer; created_at: Date; expires_at: Date;
  attempt_count: number; max_attempts: number; completed_at: Date | null;
};
type EnrollmentRow = QueryResultRow & {
  id: string; invitation_id: string; token_hash: Buffer; encrypted_totp_secret: Buffer;
  key_version: string; created_at: Date; expires_at: Date; attempt_count: number;
  max_attempts: number; invalidated_at: Date | null; completed_at: Date | null;
};
type CredentialRow = QueryResultRow & {
  id: string; user_id: string; encrypted_secret: Buffer; key_version: string;
  confirmed_at: Date; created_at: Date; updated_at: Date;
};
type RecoveryRow = QueryResultRow & {
  id: string; user_id: string; code_hash: Buffer; key_version: string; created_at: Date; used_at: Date | null;
};
type InvitationLockRow = QueryResultRow & { id: string };

const CHALLENGE_COLUMNS = "id, user_id, token_hash, created_at, expires_at, attempt_count, max_attempts, completed_at";
const ENROLLMENT_COLUMNS = "id, invitation_id, token_hash, encrypted_totp_secret, key_version, created_at, expires_at, attempt_count, max_attempts, invalidated_at, completed_at";
const CREDENTIAL_COLUMNS = "id, user_id, encrypted_secret, key_version, confirmed_at, created_at, updated_at";
const RECOVERY_COLUMNS = "id, user_id, code_hash, key_version, created_at, used_at";

function mapChallenge(row: ChallengeRow): MfaChallenge {
  return { id: row.id, userId: row.user_id, tokenHash: Buffer.from(row.token_hash), createdAt: row.created_at,
    expiresAt: row.expires_at, attemptCount: row.attempt_count, maxAttempts: row.max_attempts, completedAt: row.completed_at };
}
function mapEnrollment(row: EnrollmentRow): MfaEnrollment {
  return { id: row.id, invitationId: row.invitation_id, tokenHash: Buffer.from(row.token_hash),
    encryptedTotpSecret: Buffer.from(row.encrypted_totp_secret), keyVersion: row.key_version,
    createdAt: row.created_at, expiresAt: row.expires_at, attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts, invalidatedAt: row.invalidated_at, completedAt: row.completed_at };
}
function mapCredential(row: CredentialRow): TotpCredential {
  return { id: row.id, userId: row.user_id, encryptedSecret: Buffer.from(row.encrypted_secret),
    keyVersion: row.key_version, confirmedAt: row.confirmed_at, createdAt: row.created_at, updatedAt: row.updated_at };
}
function mapRecovery(row: RecoveryRow): RecoveryCodeRecord {
  return { id: row.id, userId: row.user_id, codeHash: Buffer.from(row.code_hash), keyVersion: row.key_version,
    createdAt: row.created_at, usedAt: row.used_at };
}

export class PostgresMfaRepository implements MfaRepository {
  constructor(private readonly executor: QueryExecutor) {}

  async createChallenge(input: CreateMfaChallengeInput) {
    const result = await this.executor.query<ChallengeRow>(
      `WITH times AS (SELECT clock_timestamp() AS now)
       INSERT INTO platform.mfa_challenges (id, user_id, token_hash, created_at, expires_at, max_attempts)
       SELECT $1, $2, $3, now, now + ($4 * interval '1 second'), $5 FROM times
       RETURNING ${CHALLENGE_COLUMNS}`,
      [createIdentityId(), input.userId, Buffer.from(input.tokenHash), input.lifetimeSeconds, input.maxAttempts]
    );
    return mapChallenge(result.rows[0]!);
  }

  async findActiveChallengeByTokenHash(tokenHash: Buffer) {
    const result = await this.executor.query<ChallengeRow>(
      `SELECT ${CHALLENGE_COLUMNS} FROM platform.mfa_challenges
       WHERE token_hash = $1 AND completed_at IS NULL AND expires_at > clock_timestamp() AND attempt_count < max_attempts`,
      [Buffer.from(tokenHash)]
    );
    return result.rows[0] ? mapChallenge(result.rows[0]) : undefined;
  }

  async recordChallengeAttempt(id: string) {
    const result = await this.executor.query<ChallengeRow>(
      `UPDATE platform.mfa_challenges SET attempt_count = attempt_count + 1
       WHERE id = $1 AND completed_at IS NULL AND expires_at > clock_timestamp() AND attempt_count < max_attempts
       RETURNING ${CHALLENGE_COLUMNS}`,
      [id]
    );
    return result.rows[0] ? mapChallenge(result.rows[0]) : undefined;
  }

  async completeChallenge(id: string) {
    const result = await this.executor.query<ChallengeRow>(
      `WITH times AS (SELECT clock_timestamp() AS now)
       UPDATE platform.mfa_challenges challenge SET completed_at = times.now
       FROM times
       WHERE challenge.id = $1 AND challenge.completed_at IS NULL
         AND challenge.expires_at > times.now AND challenge.attempt_count < challenge.max_attempts
       RETURNING ${CHALLENGE_COLUMNS}`,
      [id]
    );
    return result.rows[0] ? mapChallenge(result.rows[0]) : undefined;
  }

  async lockActiveInvitationForEnrollment(invitationId: string) {
    const result = await this.executor.query<InvitationLockRow>(
      `SELECT id FROM platform.invitations
       WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL
         AND expires_at > clock_timestamp()
       FOR UPDATE`,
      [invitationId]
    );
    return result.rowCount === 1;
  }

  async invalidateOpenEnrollmentsForInvitation(invitationId: string) {
    const result = await this.executor.query<InvitationLockRow>(
      `UPDATE platform.mfa_enrollments SET invalidated_at = clock_timestamp()
       WHERE invitation_id = $1 AND invalidated_at IS NULL AND completed_at IS NULL
       RETURNING id`,
      [invitationId]
    );
    return result.rowCount ?? 0;
  }

  async createEnrollment(input: CreateMfaEnrollmentInput) {
    const result = await this.executor.query<EnrollmentRow>(
      `WITH times AS (SELECT clock_timestamp() AS now)
       INSERT INTO platform.mfa_enrollments
         (id, invitation_id, token_hash, encrypted_totp_secret, key_version, created_at, expires_at, max_attempts)
       SELECT $1, $2, $3, $4, $5, now, now + ($6 * interval '1 second'), $7 FROM times
       RETURNING ${ENROLLMENT_COLUMNS}`,
      [createIdentityId(), input.invitationId, Buffer.from(input.tokenHash), Buffer.from(input.encryptedTotpSecret), input.keyVersion,
        input.lifetimeSeconds, input.maxAttempts]
    );
    return mapEnrollment(result.rows[0]!);
  }

  async findActiveEnrollmentByTokenHash(tokenHash: Buffer) {
    const result = await this.executor.query<EnrollmentRow>(
      `SELECT ${ENROLLMENT_COLUMNS} FROM platform.mfa_enrollments
       WHERE token_hash = $1 AND invalidated_at IS NULL AND completed_at IS NULL
         AND expires_at > clock_timestamp() AND attempt_count < max_attempts`,
      [Buffer.from(tokenHash)]
    );
    return result.rows[0] ? mapEnrollment(result.rows[0]) : undefined;
  }

  async lockActiveEnrollmentByTokenHash(tokenHash: Buffer) {
    const result = await this.executor.query<EnrollmentRow>(
      `SELECT ${ENROLLMENT_COLUMNS} FROM platform.mfa_enrollments
       WHERE token_hash = $1 AND invalidated_at IS NULL AND completed_at IS NULL
         AND expires_at > clock_timestamp() AND attempt_count < max_attempts
       FOR UPDATE`, [Buffer.from(tokenHash)]
    );
    return result.rows[0] ? mapEnrollment(result.rows[0]) : undefined;
  }

  async recordEnrollmentAttempt(id: string) {
    const result = await this.executor.query<EnrollmentRow>(
      `UPDATE platform.mfa_enrollments SET attempt_count = attempt_count + 1
       WHERE id = $1 AND invalidated_at IS NULL AND completed_at IS NULL
         AND expires_at > clock_timestamp() AND attempt_count < max_attempts
       RETURNING ${ENROLLMENT_COLUMNS}`,
      [id]
    );
    return result.rows[0] ? mapEnrollment(result.rows[0]) : undefined;
  }

  async invalidateEnrollment(id: string) {
    const result = await this.executor.query<EnrollmentRow>(
      `UPDATE platform.mfa_enrollments SET invalidated_at = clock_timestamp()
       WHERE id = $1 AND invalidated_at IS NULL AND completed_at IS NULL
       RETURNING ${ENROLLMENT_COLUMNS}`,
      [id]
    );
    return result.rows[0] ? mapEnrollment(result.rows[0]) : undefined;
  }

  async completeEnrollment(id: string) {
    const result = await this.executor.query<EnrollmentRow>(
      `WITH times AS (SELECT clock_timestamp() AS now)
       UPDATE platform.mfa_enrollments enrollment SET completed_at = times.now
       FROM times
       WHERE enrollment.id = $1 AND enrollment.invalidated_at IS NULL AND enrollment.completed_at IS NULL
         AND enrollment.expires_at > times.now AND enrollment.attempt_count < enrollment.max_attempts
       RETURNING ${ENROLLMENT_COLUMNS}`,
      [id]
    );
    return result.rows[0] ? mapEnrollment(result.rows[0]) : undefined;
  }

  async saveTotpCredential(input: SaveTotpCredentialInput) {
    const owned = ownTotpCredential(input);
    const result = await this.executor.query<CredentialRow>(
      `WITH times AS (SELECT COALESCE($5::timestamptz, clock_timestamp()) AS now)
       INSERT INTO platform.totp_credentials
         (id, user_id, encrypted_secret, key_version, confirmed_at, created_at, updated_at)
       SELECT $1, $2, $3, $4, now, now, now FROM times
       ON CONFLICT (user_id) DO UPDATE SET encrypted_secret = EXCLUDED.encrypted_secret,
         key_version = EXCLUDED.key_version, confirmed_at = EXCLUDED.confirmed_at, updated_at = EXCLUDED.updated_at
       RETURNING ${CREDENTIAL_COLUMNS}`,
      [createIdentityId(), owned.userId, owned.encryptedSecret, owned.keyVersion, owned.confirmedAt]
    );
    return mapCredential(result.rows[0]!);
  }

  async insertTotpCredential(input: SaveTotpCredentialInput) {
    const owned = ownTotpCredential(input);
    await this.executor.query(
      `WITH times AS (SELECT COALESCE($5::timestamptz, clock_timestamp()) AS now)
       INSERT INTO platform.totp_credentials
         (id, user_id, encrypted_secret, key_version, confirmed_at, created_at, updated_at)
       SELECT $1, $2, $3, $4, now, now, now FROM times`,
      [createIdentityId(), owned.userId, owned.encryptedSecret, owned.keyVersion, owned.confirmedAt]
    );
  }

  async findTotpCredentialByUserId(userId: string) {
    const result = await this.executor.query<CredentialRow>(
      `SELECT ${CREDENTIAL_COLUMNS} FROM platform.totp_credentials WHERE user_id = $1`, [userId]
    );
    return result.rows[0] ? mapCredential(result.rows[0]) : undefined;
  }

  async addRecoveryCodes(userId: string, codes: readonly { readonly keyVersion: string; readonly hash: Buffer }[]) {
    if (codes.length === 0) return [];
    const values: unknown[] = [];
    const tuples = codes.map((code, index) => {
      const offset = index * 4;
      values.push(createIdentityId(), userId, Buffer.from(code.hash), code.keyVersion);
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`;
    });
    const result = await this.executor.query<RecoveryRow>(
      `INSERT INTO platform.recovery_codes (id, user_id, code_hash, key_version) VALUES ${tuples.join(", ")}
       RETURNING ${RECOVERY_COLUMNS}`,
      values
    );
    return result.rows.map(mapRecovery);
  }

  async insertRecoveryCodes(userId: string, codes: readonly { readonly keyVersion: string; readonly hash: Buffer }[]) {
    if (codes.length === 0) return;
    const values: unknown[] = [];
    const tuples = codes.map((code, index) => {
      const offset = index * 4;
      values.push(createIdentityId(), userId, Buffer.from(code.hash), code.keyVersion);
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`;
    });
    await this.executor.query(
      `INSERT INTO platform.recovery_codes (id, user_id, code_hash, key_version)
       VALUES ${tuples.join(", ")}`,
      values
    );
  }

  async consumeRecoveryCode(userId: string, keyVersion: string, hash: Buffer) {
    const result = await this.executor.query<RecoveryRow>(
      `UPDATE platform.recovery_codes SET used_at = clock_timestamp()
       WHERE user_id = $1 AND key_version = $2 AND code_hash = $3 AND used_at IS NULL
       RETURNING ${RECOVERY_COLUMNS}`,
      [userId, keyVersion, Buffer.from(hash)]
    );
    return result.rows[0] ? mapRecovery(result.rows[0]) : undefined;
  }
}

function ownTotpCredential(input: SaveTotpCredentialInput) {
  const confirmedAt = input.confirmedAt === undefined ? null : new Date(input.confirmedAt.getTime());
  if (confirmedAt !== null && !Number.isFinite(confirmedAt.getTime())) throw new Error("INVALID_TOTP_CONFIRMED_AT");
  return {
    userId: input.userId,
    encryptedSecret: Buffer.from(input.encryptedSecret),
    keyVersion: input.keyVersion,
    confirmedAt
  };
}
