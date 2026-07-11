export type PlatformSession = {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: Buffer;
  readonly createdAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly idleExpiresAt: Date;
  readonly lastActivityAt: Date;
  readonly lastTouchAt: Date;
  readonly revokedAt: Date | null;
  readonly clientSummary: string | null;
};

export type CreateSessionInput = {
  readonly userId: string;
  readonly tokenHash: Buffer;
  readonly absoluteLifetimeSeconds: number;
  readonly idleLifetimeSeconds: number;
  readonly clientSummary?: string;
};

export interface SessionRepository {
  create(input: CreateSessionInput): Promise<PlatformSession>;
  findActiveByTokenHash(tokenHash: Buffer): Promise<PlatformSession | undefined>;
  touch(id: string, idleLifetimeSeconds: number, minimumIntervalSeconds?: number): Promise<PlatformSession | undefined>;
  revoke(id: string): Promise<PlatformSession | undefined>;
  revokeAllForUser(userId: string): Promise<number>;
}
