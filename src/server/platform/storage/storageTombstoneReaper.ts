import type { StorageAdapter } from "./storageAdapter.ts";
import { StorageError } from "./storageErrors.ts";
import type { StorageObjectRepository } from "./storageObjectRepository.ts";
import type { StorageObjectRepositoryFactory, StorageTransactionRunner } from "./storageObjectService.ts";

type Options = {
  readonly workerId: string;
  readonly leaseMs: number;
  readonly transactionRunner: StorageTransactionRunner;
  readonly createRepository: StorageObjectRepositoryFactory;
  readonly adapter: StorageAdapter;
  readonly clock: () => Date;
  readonly verificationDelayMs?: number;
  readonly reapIntervalMs?: number;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

type ReapInput = { readonly id?: string; readonly signal: AbortSignal };

export type StorageTombstoneReaper = {
  reap(input: ReapInput): Promise<
    { readonly status: "idle" | "stopped" } |
    { readonly status: "processed"; readonly objectId: string }
  >;
};

const DEFAULT_VERIFICATION_DELAY_MS = 1_000;
const DEFAULT_REAP_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const MIN_REAP_INTERVAL_MS = 60_000;
const MAX_REAP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1_000;

export function createStorageTombstoneReaper(options: Options): StorageTombstoneReaper {
  if (!options || typeof options !== "object" || typeof options.workerId !== "string" ||
      typeof options.transactionRunner !== "function" || typeof options.createRepository !== "function" ||
      typeof options.clock !== "function" || !options.adapter) {
    throw new Error("INVALID_STORAGE_TOMBSTONE_REAPER_OPTIONS");
  }
  const verificationDelayMs = options.verificationDelayMs ?? DEFAULT_VERIFICATION_DELAY_MS;
  const reapIntervalMs = options.reapIntervalMs ?? DEFAULT_REAP_INTERVAL_MS;
  if (!Number.isSafeInteger(options.leaseMs) || options.leaseMs < 2 || options.leaseMs > 3_600_000 ||
      !Number.isSafeInteger(verificationDelayMs) || verificationDelayMs < 1 || verificationDelayMs >= 30_000 ||
      !Number.isSafeInteger(reapIntervalMs) || reapIntervalMs < MIN_REAP_INTERVAL_MS ||
      reapIntervalMs > MAX_REAP_INTERVAL_MS ||
      (options.sleep !== undefined && typeof options.sleep !== "function")) {
    throw new Error("INVALID_STORAGE_TOMBSTONE_REAPER_OPTIONS");
  }
  const sleep = options.sleep ?? abortableDelay;

  return Object.freeze({
    async reap(input: ReapInput) {
      assertReapInput(input);
      if (input.signal.aborted) return { status: "stopped" as const };
      const claimAt = ownClock(options.clock());
      const claimed = await options.transactionRunner((executor) =>
        options.createRepository(executor).claimCleanupReap({
          workerId: options.workerId,
          now: claimAt,
          leaseDurationMs: options.leaseMs,
          ...(input.id === undefined ? {} : { id: input.id })
        })
      );
      if (!claimed) return { status: "idle" as const };
      if (input.signal.aborted) {
        await releaseClaim(options, claimed.id, claimed.cleanupGeneration, claimed.cleanupLeaseToken!, input.signal);
        return { status: "stopped" as const };
      }

      let lastError: string | null;
      try {
        lastError = await reapBytes(options.adapter, claimed.objectKey, verificationDelayMs, sleep, input.signal);
      } catch (error) {
        if (!input.signal.aborted) throw error;
        await releaseClaim(options, claimed.id, claimed.cleanupGeneration, claimed.cleanupLeaseToken!, input.signal);
        return { status: "stopped" as const };
      }
      if (input.signal.aborted) {
        await releaseClaim(options, claimed.id, claimed.cleanupGeneration, claimed.cleanupLeaseToken!, input.signal);
        return { status: "stopped" as const };
      }

      const scheduledAt = ownClock(options.clock());
      const nextCleanupAt = addMilliseconds(scheduledAt, reapIntervalMs);
      await options.transactionRunner((executor) => options.createRepository(executor).scheduleCleanupReap({
        id: claimed.id,
        driver: claimed.driver,
        objectKey: claimed.objectKey,
        workerId: options.workerId,
        leaseToken: claimed.cleanupLeaseToken!,
        expectedGeneration: claimed.cleanupGeneration,
        scheduledAt,
        nextCleanupAt,
        lastError
      }));
      return { status: "processed" as const, objectId: claimed.id };
    }
  });
}

async function releaseClaim(
  options: Options,
  id: string,
  expectedGeneration: number,
  leaseToken: string,
  _signal: AbortSignal
) {
  const releasedAt = ownClock(options.clock());
  await options.transactionRunner((executor) => options.createRepository(executor).releaseCleanupReap({
    id,
    workerId: options.workerId,
    leaseToken,
    expectedGeneration,
    releasedAt
  }));
}

async function reapBytes(
  adapter: StorageAdapter,
  objectKey: string,
  verificationDelayMs: number,
  sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>,
  signal: AbortSignal
) {
  let lastError = await attemptDelete(adapter, objectKey, signal);
  signal.throwIfAborted();
  await sleep(verificationDelayMs, signal);
  signal.throwIfAborted();
  lastError = (await attemptDelete(adapter, objectKey, signal)) ?? lastError;
  signal.throwIfAborted();
  try {
    return await adapter.head(objectKey, { signal }) === null ? lastError : "STORAGE_DELETE_NOT_VERIFIED";
  } catch {
    signal.throwIfAborted();
    return "STORAGE_DELETE_VERIFY_FAILED";
  }
}

async function attemptDelete(adapter: StorageAdapter, objectKey: string, signal: AbortSignal) {
  try {
    await adapter.delete(objectKey, { signal });
    return null;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof StorageError && error.code === "OBJECT_NOT_FOUND") return null;
    return "STORAGE_DELETE_FAILED";
  }
}

function assertReapInput(input: ReapInput) {
  if (!input || typeof input !== "object" || !input.signal || typeof input.signal.aborted !== "boolean" ||
      (input.id !== undefined && typeof input.id !== "string")) {
    throw new Error("INVALID_STORAGE_TOMBSTONE_REAP_INPUT");
  }
}

function addMilliseconds(date: Date, milliseconds: number) {
  const value = date.getTime() + milliseconds;
  if (!Number.isSafeInteger(value) || Math.abs(value) > 8_640_000_000_000_000) {
    throw new Error("INVALID_STORAGE_TOMBSTONE_CLOCK");
  }
  return new Date(value);
}

function ownClock(value: Date) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("INVALID_STORAGE_TOMBSTONE_CLOCK");
  }
  return new Date(value.getTime());
}

function abortableDelay(milliseconds: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}
