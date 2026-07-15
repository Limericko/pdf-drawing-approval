export type SecurityRateLimitBucketType = "account" | "ip-prefix";

export type SecurityRateLimitBucket = {
  readonly bucketType: SecurityRateLimitBucketType;
  readonly bucketKey: Buffer;
  readonly windowStartedAt: Date;
  readonly attemptCount: number;
  readonly blockedUntil: Date | null;
  readonly blocked: boolean;
  readonly updatedAt: Date;
};

export type IncrementRateLimitInput = {
  readonly bucketType: SecurityRateLimitBucketType;
  readonly bucketKey: Buffer;
  readonly windowSeconds: number;
  readonly limit: number;
  readonly blockSeconds: number;
};

export interface RateLimitRepository {
  increment(input: IncrementRateLimitInput): Promise<SecurityRateLimitBucket>;
}
