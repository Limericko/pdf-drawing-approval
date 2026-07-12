import type { QueryExecutor } from "../../database/queryExecutor.ts";
import type { StorageAdapter, StorageDriver } from "../../storage/storageAdapter.ts";
import { StorageError } from "../../storage/storageErrors.ts";
import type { StorageObjectRepository } from "../../storage/storageObjectRepository.ts";
import { assertStorageKey } from "../../storage/storageKey.ts";
import type { Job } from "../jobTypes.ts";
import { JobHandlerError, type JobHandler } from "../jobRegistry.ts";

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type TransactionRunner = <T>(callback: (executor: QueryExecutor) => Promise<T>) => Promise<T>;

type Options = {
  readonly transactionRunner: TransactionRunner;
  readonly createRepository: (executor: QueryExecutor) => StorageObjectRepository;
  readonly adapter: StorageAdapter;
  readonly clock: () => Date;
};

type CleanupPayload = {
  readonly idempotencyKey: string;
  readonly storageObjectId: string;
  readonly expectedStatus: "staging" | "delete_pending";
  readonly driver: StorageDriver;
  readonly objectKey: string;
};

export function createDeleteStorageObjectHandler(options: Options): JobHandler {
  if (!options || typeof options !== "object" || typeof options.transactionRunner !== "function" ||
      typeof options.createRepository !== "function" || typeof options.clock !== "function" || !options.adapter) {
    throw new Error("INVALID_STORAGE_CLEANUP_HANDLER_OPTIONS");
  }
  const { transactionRunner, createRepository, adapter, clock } = options;
  return async (job: Job) => {
    const payload = ownPayload(job?.payload);
    if (payload.driver !== adapter.driver) {
      throw new JobHandlerError("permanent", "STORAGE_DRIVER_MISMATCH", "Cleanup storage driver does not match active adapter");
    }
    const requestedAt = ownClock(clock());
    const prepared = await transactionRunner((executor) => createRepository(executor).prepareCleanup({
      id: payload.storageObjectId,
      expectedStatus: payload.expectedStatus,
      driver: payload.driver,
      objectKey: payload.objectKey,
      requestedAt
    }));
    if (!prepared) return;

    try {
      await adapter.delete(payload.objectKey);
    } catch (error) {
      if (!(error instanceof StorageError && error.code === "OBJECT_NOT_FOUND")) {
        throw new JobHandlerError("transient", "STORAGE_DELETE_FAILED", "Storage object deletion failed");
      }
    }

    const deletedAt = ownClock(clock());
    await transactionRunner((executor) => createRepository(executor).completeCleanup({
      id: payload.storageObjectId,
      driver: payload.driver,
      objectKey: payload.objectKey,
      deletedAt
    }));
  };
}

function ownPayload(value: unknown): CleanupPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidPayload();
  const payload = value as Record<string, unknown>;
  const keys = Object.keys(payload).sort();
  const expectedKeys = ["driver", "expectedStatus", "idempotencyKey", "objectKey", "storageObjectId"];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) throw invalidPayload();
  if (typeof payload.storageObjectId !== "string" || !UUID_V7_PATTERN.test(payload.storageObjectId) ||
      (payload.expectedStatus !== "staging" && payload.expectedStatus !== "delete_pending") ||
      (payload.driver !== "filesystem" && payload.driver !== "s3") || typeof payload.objectKey !== "string" ||
      typeof payload.idempotencyKey !== "string") throw invalidPayload();
  try {
    if (assertStorageKey(payload.objectKey).id !== payload.storageObjectId) throw invalidPayload();
  } catch {
    throw invalidPayload();
  }
  const expectedIdempotencyKey = `storage-object-cleanup:${payload.storageObjectId}:${payload.expectedStatus}`;
  if (payload.idempotencyKey !== expectedIdempotencyKey) throw invalidPayload();
  return {
    idempotencyKey: payload.idempotencyKey,
    storageObjectId: payload.storageObjectId,
    expectedStatus: payload.expectedStatus,
    driver: payload.driver,
    objectKey: payload.objectKey
  };
}

function ownClock(value: Date) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new JobHandlerError("transient", "INVALID_WORKER_CLOCK", "Worker clock returned an invalid timestamp");
  }
  return new Date(value.getTime());
}

function invalidPayload() {
  return new JobHandlerError("permanent", "INVALID_STORAGE_CLEANUP_PAYLOAD", "Storage cleanup payload is invalid");
}
