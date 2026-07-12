import { createHash } from "node:crypto";
import type { PlatformPool } from "../database/pool.ts";
import { withTransaction } from "../database/transaction.ts";
import { PostgresRateLimitRepository } from "../../modules/identity/repositories/postgres/PostgresRateLimitRepository.ts";

const OPERATION_PATTERN = /^[a-z][a-z0-9.-]{0,63}$/;
const MAX_IDENTITY_BYTES = 256;
const MAX_WINDOW_SECONDS = 7 * 24 * 60 * 60;
const MAX_BLOCK_SECONDS = 30 * 24 * 60 * 60;
const MAX_LIMIT = 10_000;

export type RateLimitPolicy = {
  readonly windowSeconds: number;
  readonly limit: number;
  readonly blockSeconds: number;
};

export type RateLimitDecision = {
  readonly blocked: boolean;
  readonly attemptCount: number;
  readonly blockedUntil: Date | null;
};

export class RateLimitServiceError extends Error {
  constructor(readonly code:
    | "RATE_LIMIT_INPUT_INVALID"
    | "RATE_LIMIT_POLICY_INVALID"
    | "RATE_LIMIT_DEPENDENCY_UNAVAILABLE", options?: ErrorOptions) {
    super(code, options);
    this.name = "RateLimitServiceError";
  }
}

export function createRateLimitService(options: { readonly pool: PlatformPool }) {
  if (!options?.pool) throw inputInvalid();

  const consume = async (
    operation: string,
    scope: "ip-prefix" | "account",
    identity: Buffer,
    policy: RateLimitPolicy
  ): Promise<RateLimitDecision> => {
    assertOperation(operation);
    assertIdentity(identity);
    assertPolicy(policy);
    const bucketKey = domainKey(operation, scope, identity);
    try {
      let bucket;
      try {
        bucket = await withTransaction(options.pool, (transaction) =>
          new PostgresRateLimitRepository(transaction).increment({
            bucketType: scope,
            bucketKey,
            windowSeconds: policy.windowSeconds,
            limit: policy.limit,
            blockSeconds: policy.blockSeconds
          })
        );
      } catch (error) {
        if (error instanceof RateLimitServiceError) throw error;
        throw new RateLimitServiceError("RATE_LIMIT_DEPENDENCY_UNAVAILABLE", { cause: error });
      }
      return Object.freeze({
        blocked: bucket.blocked,
        attemptCount: bucket.attemptCount,
        blockedUntil: bucket.blockedUntil ? new Date(bucket.blockedUntil) : null
      });
    } finally {
      bucketKey.fill(0);
    }
  };

  return Object.freeze({
    consumeIp(input: {
      readonly operation: string;
      readonly sourceIpPrefix: string;
      readonly policy: RateLimitPolicy;
    }) {
      if (typeof input?.sourceIpPrefix !== "string" || input.sourceIpPrefix !== input.sourceIpPrefix.trim() ||
          !input.sourceIpPrefix || Buffer.byteLength(input.sourceIpPrefix) > 128 || /[\r\n\0]/.test(input.sourceIpPrefix)) {
        return Promise.reject(inputInvalid());
      }
      return consume(input.operation, "ip-prefix", Buffer.from(input.sourceIpPrefix, "utf8"), input.policy);
    },
    consumeAccount(input: {
      readonly operation: string;
      readonly accountKey: Buffer;
      readonly policy: RateLimitPolicy;
    }) {
      if (!Buffer.isBuffer(input?.accountKey)) return Promise.reject(inputInvalid());
      return consume(input.operation, "account", input.accountKey, input.policy);
    }
  });
}

function domainKey(operation: string, scope: string, identity: Buffer) {
  return createHash("sha256")
    .update(`${operation}.${scope === "ip-prefix" ? "ip" : "account"}`, "utf8")
    .update("\0", "utf8")
    .update(identity)
    .digest();
}

function assertOperation(value: string) {
  if (typeof value !== "string" || !OPERATION_PATTERN.test(value)) throw inputInvalid();
}

function assertIdentity(value: Buffer) {
  if (!Buffer.isBuffer(value) || value.length === 0 || value.length > MAX_IDENTITY_BYTES) throw inputInvalid();
}

function assertPolicy(value: RateLimitPolicy) {
  if (!value || !isBounded(value.windowSeconds, MAX_WINDOW_SECONDS) ||
      !isBounded(value.blockSeconds, MAX_BLOCK_SECONDS) || !isBounded(value.limit, MAX_LIMIT)) {
    throw new RateLimitServiceError("RATE_LIMIT_POLICY_INVALID");
  }
}

function isBounded(value: number, maximum: number) {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function inputInvalid() {
  return new RateLimitServiceError("RATE_LIMIT_INPUT_INVALID");
}
