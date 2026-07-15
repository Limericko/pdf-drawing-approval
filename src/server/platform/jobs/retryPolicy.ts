export type RetrySchedule = {
  readonly delayMs: number;
  readonly nextRunAt: Date;
};

export type RetryPolicy = {
  next(attempt: number): RetrySchedule;
};

export type RetryPolicyOptions = {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly random: () => number;
  readonly clock: () => Date;
};

export class RetryPolicyError extends Error {
  readonly code = "INVALID_RETRY_POLICY";

  constructor() {
    super("Invalid retry policy input");
    this.name = "RetryPolicyError";
  }
}

export function createRetryPolicy(options: RetryPolicyOptions): RetryPolicy {
  const baseDelayMs = ownPositiveSafeInteger(options.baseDelayMs);
  const maxDelayMs = ownPositiveSafeInteger(options.maxDelayMs);
  if (baseDelayMs > maxDelayMs || typeof options.random !== "function" || typeof options.clock !== "function") {
    throw invalidPolicy();
  }
  const { random, clock } = options;

  return Object.freeze({
    next(attempt: number) {
      if (!Number.isSafeInteger(attempt) || attempt < 1) throw invalidPolicy();
      const now = ownDate(clock());
      const sample = random();
      if (typeof sample !== "number" || !Number.isFinite(sample) || sample < 0 || sample >= 1) {
        throw invalidPolicy();
      }
      const cappedDelayMs = cappedExponentialDelay(baseDelayMs, maxDelayMs, attempt);
      const jitterRange = cappedDelayMs < Number.MAX_SAFE_INTEGER ? cappedDelayMs + 1 : cappedDelayMs;
      const delayMs = Math.min(cappedDelayMs, Math.floor(sample * jitterRange));
      const nextTimestamp = now.getTime() + delayMs;
      if (!Number.isSafeInteger(nextTimestamp) || Math.abs(nextTimestamp) > 8_640_000_000_000_000) {
        throw invalidPolicy();
      }
      return Object.freeze({ delayMs, nextRunAt: new Date(nextTimestamp) });
    }
  });
}

function cappedExponentialDelay(baseDelayMs: number, maxDelayMs: number, attempt: number) {
  let delay = baseDelayMs;
  for (let currentAttempt = 1; currentAttempt < attempt && delay < maxDelayMs; currentAttempt += 1) {
    delay = delay > Math.floor(maxDelayMs / 2) ? maxDelayMs : delay * 2;
  }
  return delay;
}

function ownPositiveSafeInteger(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) throw invalidPolicy();
  return value;
}

function ownDate(value: Date) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw invalidPolicy();
  return new Date(value.getTime());
}

function invalidPolicy() {
  return new RetryPolicyError();
}
