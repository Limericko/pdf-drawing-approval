export type MfaChallenge = {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: Buffer;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly completedAt: Date | null;
};

export type MfaEnrollment = {
  readonly id: string;
  readonly invitationId: string;
  readonly tokenHash: Buffer;
  readonly encryptedTotpSecret: Buffer;
  readonly keyVersion: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly invalidatedAt: Date | null;
  readonly completedAt: Date | null;
};

export type TotpCredential = {
  readonly id: string;
  readonly userId: string;
  readonly encryptedSecret: Buffer;
  readonly keyVersion: string;
  readonly confirmedAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export type RecoveryCodeRecord = {
  readonly id: string;
  readonly userId: string;
  readonly codeHash: Buffer;
  readonly keyVersion: string;
  readonly createdAt: Date;
  readonly usedAt: Date | null;
};

export type CreateMfaChallengeInput = {
  readonly userId: string;
  readonly tokenHash: Buffer;
  readonly lifetimeSeconds: number;
  readonly maxAttempts: number;
};

export type CreateMfaEnrollmentInput = {
  readonly invitationId: string;
  readonly tokenHash: Buffer;
  readonly encryptedTotpSecret: Buffer;
  readonly keyVersion: string;
  readonly lifetimeSeconds: number;
  readonly maxAttempts: number;
};

export type SaveTotpCredentialInput = {
  readonly userId: string;
  readonly encryptedSecret: Buffer;
  readonly keyVersion: string;
  readonly confirmedAt?: Date;
};

export interface MfaRepository {
  createChallenge(input: CreateMfaChallengeInput): Promise<MfaChallenge>;
  findActiveChallengeByTokenHash(tokenHash: Buffer): Promise<MfaChallenge | undefined>;
  recordChallengeAttempt(id: string): Promise<MfaChallenge | undefined>;
  completeChallenge(id: string): Promise<MfaChallenge | undefined>;
  /**
   * Shared first step for enrollment preparation and completion. Any service transaction that mutates
   * an enrollment and consumes its invitation must acquire this lock first. The global lock order is
   * invitation, then enrollment; keep invalidate/create or complete/consume in this same transaction.
   */
  lockActiveInvitationForEnrollment(invitationId: string): Promise<boolean>;
  /** Must be composed after lockActiveInvitationForEnrollment() in the same service transaction. */
  invalidateOpenEnrollmentsForInvitation(invitationId: string): Promise<number>;
  createEnrollment(input: CreateMfaEnrollmentInput): Promise<MfaEnrollment>;
  findActiveEnrollmentByTokenHash(tokenHash: Buffer): Promise<MfaEnrollment | undefined>;
  recordEnrollmentAttempt(id: string): Promise<MfaEnrollment | undefined>;
  invalidateEnrollment(id: string): Promise<MfaEnrollment | undefined>;
  /** When consuming the invitation too, lock the invitation first and use the same service transaction. */
  completeEnrollment(id: string): Promise<MfaEnrollment | undefined>;
  saveTotpCredential(input: SaveTotpCredentialInput): Promise<TotpCredential>;
  insertTotpCredential(input: SaveTotpCredentialInput): Promise<void>;
  findTotpCredentialByUserId(userId: string): Promise<TotpCredential | undefined>;
  addRecoveryCodes(userId: string, codes: readonly { readonly keyVersion: string; readonly hash: Buffer }[]): Promise<readonly RecoveryCodeRecord[]>;
  insertRecoveryCodes(userId: string, codes: readonly { readonly keyVersion: string; readonly hash: Buffer }[]): Promise<void>;
  consumeRecoveryCode(userId: string, keyVersion: string, hash: Buffer): Promise<RecoveryCodeRecord | undefined>;
}
