import type { StorageAdapter } from "./storageAdapter.ts";
import { StorageError } from "./storageErrors.ts";
import type { StorageObject, StorageObjectRepository } from "./storageObjectRepository.ts";
import type { StorageObjectRepositoryFactory, StorageTransactionRunner } from "./storageObjectService.ts";

type Options = {
  readonly transactionRunner: StorageTransactionRunner;
  readonly createRepository: StorageObjectRepositoryFactory;
  readonly adapter: StorageAdapter;
  readonly clock: () => Date;
  readonly verificationDelayMs?: number;
  readonly reapIntervalMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
};

export type StorageTombstoneReaper = {
  reap(object: StorageObject): Promise<StorageObject | undefined>;
};

const DEFAULT_VERIFICATION_DELAY_MS = 1_000;
const DEFAULT_REAP_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const MIN_REAP_INTERVAL_MS = 60_000;
const MAX_REAP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1_000;

export function createStorageTombstoneReaper(options: Options): StorageTombstoneReaper {
  if (!options || typeof options !== "object" || typeof options.transactionRunner !== "function" ||
      typeof options.createRepository !== "function" || typeof options.clock !== "function" || !options.adapter) {
    throw new Error("INVALID_STORAGE_TOMBSTONE_REAPER_OPTIONS");
  }
  const verificationDelayMs = options.verificationDelayMs ?? DEFAULT_VERIFICATION_DELAY_MS;
  const reapIntervalMs = options.reapIntervalMs ?? DEFAULT_REAP_INTERVAL_MS;
  if (!Number.isSafeInteger(verificationDelayMs) || verificationDelayMs < 1 || verificationDelayMs >= 30_000 ||
      !Number.isSafeInteger(reapIntervalMs) || reapIntervalMs < MIN_REAP_INTERVAL_MS ||
      reapIntervalMs > MAX_REAP_INTERVAL_MS ||
      (options.sleep !== undefined && typeof options.sleep !== "function")) {
    throw new Error("INVALID_STORAGE_TOMBSTONE_REAPER_OPTIONS");
  }
  const sleep = options.sleep ?? delay;

  return Object.freeze({
    async reap(object: StorageObject) {
      assertTombstone(object, options.adapter);
      const expectedGeneration = object.cleanupGeneration;
      const lastError = await reapBytes(options.adapter, object.objectKey, verificationDelayMs, sleep);
      const scheduledAt = ownClock(options.clock());
      const nextCleanupAt = addMilliseconds(scheduledAt, reapIntervalMs);
      return options.transactionRunner((executor) => options.createRepository(executor).scheduleCleanupReap({
        id: object.id,
        driver: object.driver,
        objectKey: object.objectKey,
        expectedGeneration,
        scheduledAt,
        nextCleanupAt,
        lastError
      }));
    }
  });
}

function assertTombstone(object: StorageObject, adapter: StorageAdapter) {
  if (!object || object.status !== "delete_pending" || object.driver !== "s3" ||
      object.driver !== adapter.driver || !object.cleanupTombstone ||
      !Number.isSafeInteger(object.cleanupGeneration) || object.cleanupGeneration < 0 ||
      !(object.cleanupNotBefore instanceof Date) || !Number.isFinite(object.cleanupNotBefore.getTime())) {
    throw new Error("INVALID_STORAGE_TOMBSTONE");
  }
}

async function reapBytes(
  adapter: StorageAdapter,
  objectKey: string,
  verificationDelayMs: number,
  sleep: (milliseconds: number) => Promise<void>
) {
  await attemptDelete(adapter, objectKey);
  await sleep(verificationDelayMs);
  await attemptDelete(adapter, objectKey);
  try {
    return await adapter.head(objectKey) === null ? null : "STORAGE_DELETE_NOT_VERIFIED";
  } catch {
    return "STORAGE_DELETE_VERIFY_FAILED";
  }
}

async function attemptDelete(adapter: StorageAdapter, objectKey: string) {
  try {
    await adapter.delete(objectKey);
  } catch (error) {
    if (error instanceof StorageError && error.code === "OBJECT_NOT_FOUND") return;
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

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
