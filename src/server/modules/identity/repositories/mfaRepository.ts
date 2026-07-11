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

export interface MfaRepository {
  createChallenge(input: CreateMfaChallengeInput): Promise<MfaChallenge>;
  findActiveChallengeByTokenHash(tokenHash: Buffer): Promise<MfaChallenge | undefined>;
  recordChallengeAttempt(id: string): Promise<MfaChallenge | undefined>;
  completeChallenge(id: string): Promise<MfaChallenge | undefined>;
  /**
   * First step of enrollment preparation. Call on a transaction-bound repository, then call
   * invalidateOpenEnrollmentsForInvitation() and createEnrollment() in that same service transaction.
   */
  lockActiveInvitationForEnrollment(invitationId: string): Promise<boolean>;
  /** Must be composed after lockActiveInvitationForEnrollment() in the same service transaction. */
  invalidateOpenEnrollmentsForInvitation(invitationId: string): Promise<number>;
  createEnrollment(input: CreateMfaEnrollmentInput): Promise<MfaEnrollment>;
  findActiveEnrollmentByTokenHash(tokenHash: Buffer): Promise<MfaEnrollment | undefined>;
  recordEnrollmentAttempt(id: string): Promise<MfaEnrollment | undefined>;
  invalidateEnrollment(id: string): Promise<MfaEnrollment | undefined>;
  completeEnrollment(id: string): Promise<MfaEnrollment | undefined>;
  saveTotpCredential(input: { readonly userId: string; readonly encryptedSecret: Buffer; readonly keyVersion: string }): Promise<TotpCredential>;
  findTotpCredentialByUserId(userId: string): Promise<TotpCredential | undefined>;
  addRecoveryCodes(userId: string, codes: readonly { readonly keyVersion: string; readonly hash: Buffer }[]): Promise<readonly RecoveryCodeRecord[]>;
  consumeRecoveryCode(userId: string, keyVersion: string, hash: Buffer): Promise<RecoveryCodeRecord | undefined>;
}
