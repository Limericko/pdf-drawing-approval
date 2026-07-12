export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export type JsonObject = { readonly [key: string]: JsonValue };

export type OutboxEvent = {
  readonly id: string;
  readonly eventType: string;
  readonly payloadVersion: number;
  readonly payload: JsonObject;
  readonly createdAt: Date;
  readonly dispatchedAt: Date | null;
};

export type PublishOutboxEvent = Pick<OutboxEvent, "eventType" | "payloadVersion" | "payload">;

export type JobStatus = "pending" | "running" | "succeeded" | "dead";

export type Job = {
  readonly id: string;
  readonly jobType: string;
  readonly payloadVersion: number;
  readonly payload: JsonObject;
  readonly idempotencyKey: string;
  readonly status: JobStatus;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly nextRunAt: Date;
  readonly leaseExpiresAt: Date | null;
  readonly leaseToken: string | null;
  readonly workerId: string | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorMessage: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
};

export type CreateJob = Pick<
  Job,
  "id" | "jobType" | "payloadVersion" | "payload" | "idempotencyKey" | "maxAttempts" | "nextRunAt" | "createdAt"
>;

export type JobLease = {
  readonly id: string;
  readonly workerId: string;
  readonly leaseToken: string;
};

export type JobRepositoryErrorCode =
  | "INVALID_JOB_INPUT"
  | "INVALID_JOB_ID"
  | "INVALID_JOB_DATE"
  | "INVALID_JOB_DATE_ORDER"
  | "INVALID_JOB_LIMIT"
  | "INVALID_JOB_ROW"
  | "JOB_NOT_FOUND"
  | "JOB_IDEMPOTENCY_CONFLICT"
  | "STALE_LEASE";

export class JobRepositoryError extends Error {
  constructor(readonly code: JobRepositoryErrorCode, message: string) {
    super(message);
    this.name = "JobRepositoryError";
  }
}

export type OutboxRepositoryErrorCode =
  | "INVALID_OUTBOX_EVENT"
  | "INVALID_OUTBOX_ID"
  | "INVALID_OUTBOX_DATE"
  | "INVALID_OUTBOX_LIMIT"
  | "INVALID_OUTBOX_ROW"
  | "OUTBOX_EVENT_NOT_FOUND"
  | "OUTBOX_EVENT_STATE_CONFLICT"
  | "OUTBOX_IDEMPOTENCY_CONFLICT";

export class OutboxRepositoryError extends Error {
  constructor(readonly code: OutboxRepositoryErrorCode, message: string) {
    super(message);
    this.name = "OutboxRepositoryError";
  }
}

export function cloneJsonObject(value: unknown, invalid: () => Error): JsonObject {
  try {
    const active = new WeakSet<object>();
    const cloned = cloneJsonValue(value, active, invalid, 0, { remaining: 10_000 });
    if (!isJsonObject(cloned)) throw invalid();
    return cloned;
  } catch {
    throw invalid();
  }
}

function cloneJsonValue(
  value: unknown,
  active: WeakSet<object>,
  invalid: () => Error,
  depth: number,
  budget: { remaining: number }
): JsonValue {
  budget.remaining -= 1;
  if (depth > 64 || budget.remaining < 0) throw invalid();
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid();
    return value;
  }
  if (typeof value !== "object") throw invalid();
  if (active.has(value)) throw invalid();
  active.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      if (keys.some((key) => key !== "length" && (typeof key !== "string" || !/^\d+$/.test(key)))) throw invalid();
      const cloned: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) throw invalid();
        cloned.push(cloneJsonValue(value[index], active, invalid, depth + 1, budget));
      }
      return cloned;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw invalid();
    const cloned: Record<string, JsonValue> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key)) throw invalid();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) throw invalid();
      cloned[key] = cloneJsonValue(descriptor.value, active, invalid, depth + 1, budget);
    }
    return cloned;
  } finally {
    active.delete(value);
  }
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
