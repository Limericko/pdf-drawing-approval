import type { Readable } from "node:stream";
import { v7 as uuidv7 } from "uuid";
import type { QueryExecutor } from "../database/queryExecutor.ts";
import { createCleanupIntent, type CleanupIntentPublisher } from "./cleanupIntentPublisher.ts";
import type { StorageAdapter, StorageDriver, StorageWriteResult } from "./storageAdapter.ts";
import { StorageError } from "./storageErrors.ts";
import { createStorageKey } from "./storageKey.ts";
import {
  type StorageObject,
  type StorageObjectRepository,
  StorageObjectRepositoryError
} from "./storageObjectRepository.ts";

export type StorageTransactionRunner = <T>(callback: (executor: QueryExecutor) => Promise<T>) => Promise<T>;
export type StorageObjectRepositoryFactory = (executor: QueryExecutor) => StorageObjectRepository;

export type StorageObjectServiceErrorCode =
  | "INVALID_STORAGE_OBJECT_MEDIA_TYPE"
  | "INVALID_STORAGE_OBJECT_CLOCK"
  | "STORAGE_OBJECT_NOT_FOUND"
  | "STORAGE_OBJECT_NOT_READY"
  | "STORAGE_OBJECT_DRIVER_MISMATCH"
  | "STORAGE_OBJECT_HEAD_MISMATCH"
  | "STORAGE_UPLOAD_EXPIRED"
  | "STORAGE_UPLOAD_SUPERSEDED";

export class StorageObjectServiceError extends Error {
  constructor(readonly code: StorageObjectServiceErrorCode, message: string) {
    super(message);
    this.name = "StorageObjectServiceError";
  }
}

type StorageObjectServiceDependencies = {
  readonly storage: StorageAdapter;
  readonly transactionRunner: StorageTransactionRunner;
  readonly createRepository: StorageObjectRepositoryFactory;
  readonly createId?: () => string;
  readonly clock?: () => Date;
  readonly uploadTimeoutMs?: number;
  readonly scheduleTimeout?: (callback: () => void, milliseconds: number) => () => void;
};

const DEFAULT_UPLOAD_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const MAX_UPLOAD_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1_000;

export class StorageObjectService {
  private readonly createId: () => string;
  private readonly clock: () => Date;
  private readonly uploadTimeoutMs: number;
  private readonly scheduleTimeout: (callback: () => void, milliseconds: number) => () => void;

  constructor(private readonly dependencies: StorageObjectServiceDependencies) {
    this.createId = dependencies.createId ?? uuidv7;
    this.clock = dependencies.clock ?? (() => new Date());
    this.uploadTimeoutMs = dependencies.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.uploadTimeoutMs) || this.uploadTimeoutMs < 1 || this.uploadTimeoutMs > MAX_UPLOAD_TIMEOUT_MS) {
      throw new StorageObjectServiceError("INVALID_STORAGE_OBJECT_CLOCK", "Invalid storage upload timeout");
    }
    this.scheduleTimeout = dependencies.scheduleTimeout ?? scheduleTimeout;
  }

  async create(input: { readonly body: Readable; readonly mediaType: string; readonly signal?: AbortSignal }): Promise<StorageObject> {
    const body = input.body;
    const rawMediaType = input.mediaType;
    const callerSignal = input.signal;
    if (callerSignal !== undefined && !(callerSignal instanceof AbortSignal)) {
      throw new StorageObjectServiceError("INVALID_STORAGE_OBJECT_CLOCK", "Invalid storage upload signal");
    }
    const bodyMonitor = new PrewriteBodyMonitor(body);
    let writeStarted = false;
    try {
      const mediaType = normalizeMediaType(rawMediaType);
      const id = this.createId();
      const objectKey = createStorageKey("objects/original", id);
      const createdAt = this.now();
      const uploadExpiresAt = addMilliseconds(createdAt, this.uploadTimeoutMs);
      const staged = await this.dependencies.transactionRunner((executor) =>
        this.dependencies.createRepository(executor).createStaging({
          id,
          driver: this.dependencies.storage.driver,
          objectKey,
          createdAt,
          uploadExpiresAt
        })
      );
      this.assertCurrentDriver(staged.driver);

      bodyMonitor.assertReadyForStorage();
      writeStarted = true;
      const deadlineController = new AbortController();
      const signal = callerSignal
        ? AbortSignal.any([callerSignal, deadlineController.signal])
        : deadlineController.signal;
      const remainingMs = Math.max(0, uploadExpiresAt.getTime() - this.now().getTime());
      const cancelDeadline = this.scheduleTimeout(() => deadlineController.abort(), remainingMs);
      let written: StorageWriteResult;
      try {
        written = await this.dependencies.storage.write(staged.objectKey, body, mediaType, { signal });
      } catch (error) {
        try {
          await bodyMonitor.finishStorageWrite(true);
        } finally {
          cancelDeadline();
        }
        throw error;
      }
      try {
        await bodyMonitor.finishStorageWrite(false);
      } catch (error) {
        cancelDeadline();
        throw error;
      }
      try {
        const beforeHead = this.now();
        if (signal.aborted || beforeHead.getTime() >= uploadExpiresAt.getTime()) {
          await this.dependencies.storage.delete(staged.objectKey);
          throw new StorageObjectServiceError("STORAGE_UPLOAD_EXPIRED", "Storage upload deadline expired before commit");
        }
        const head = await this.dependencies.storage.head(staged.objectKey);
        if (head === null || head.sizeBytes !== written.sizeBytes) {
          throw new StorageObjectServiceError("STORAGE_OBJECT_HEAD_MISMATCH", "Stored object size verification failed");
        }
        const readyAt = this.now();
        if (signal.aborted || readyAt.getTime() >= uploadExpiresAt.getTime()) {
          await this.dependencies.storage.delete(staged.objectKey);
          throw new StorageObjectServiceError("STORAGE_UPLOAD_EXPIRED", "Storage upload deadline expired before commit");
        }

        try {
          return await this.dependencies.transactionRunner((executor) =>
            this.dependencies.createRepository(executor).markReady(staged.id, {
              sizeBytes: written.sizeBytes,
              sha256: Buffer.from(written.sha256),
              mediaType,
              readyAt
            })
          );
        } catch (error) {
          if (error instanceof StorageObjectRepositoryError &&
              (error.code === "STORAGE_OBJECT_STATE_CONFLICT" || error.code === "STORAGE_OBJECT_UPLOAD_EXPIRED")) {
            const current = await this.dependencies.transactionRunner((executor) =>
              this.dependencies.createRepository(executor).findById(staged.id)
            );
            if (current && current.driver === staged.driver && current.objectKey === staged.objectKey &&
                (current.status === "delete_pending" || current.status === "deleted")) {
              await this.dependencies.storage.delete(staged.objectKey);
              throw new StorageObjectServiceError("STORAGE_UPLOAD_SUPERSEDED", "Storage upload was superseded by cleanup");
            }
          }
          throw error;
        }
      } finally {
        cancelDeadline();
      }
    } catch (error) {
      if (!writeStarted) await bodyMonitor.destroyAndReport(error);
      throw error;
    }
  }

  async openRead(id: string) {
    const object = await this.dependencies.transactionRunner((executor) =>
      this.dependencies.createRepository(executor).findById(id)
    );
    if (!object) {
      throw new StorageObjectServiceError("STORAGE_OBJECT_NOT_FOUND", "Storage object metadata was not found");
    }
    if (object.status !== "ready") {
      throw new StorageObjectServiceError("STORAGE_OBJECT_NOT_READY", "Storage object is not ready");
    }
    this.assertCurrentDriver(object.driver);
    return this.dependencies.storage.openRead(object.objectKey);
  }

  private assertCurrentDriver(driver: StorageDriver) {
    if (driver !== this.dependencies.storage.driver) {
      throw new StorageObjectServiceError("STORAGE_OBJECT_DRIVER_MISMATCH", "Configured storage driver does not own this object");
    }
  }

  private now() {
    const now = this.clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new StorageObjectServiceError("INVALID_STORAGE_OBJECT_CLOCK", "Invalid storage object service clock");
    }
    return new Date(now.getTime());
  }
}

function addMilliseconds(date: Date, milliseconds: number) {
  const value = date.getTime() + milliseconds;
  if (!Number.isSafeInteger(value) || Math.abs(value) > 8_640_000_000_000_000) {
    throw new StorageObjectServiceError("INVALID_STORAGE_OBJECT_CLOCK", "Invalid storage upload deadline");
  }
  return new Date(value);
}

function scheduleTimeout(callback: () => void, milliseconds: number) {
  const timer = setTimeout(callback, milliseconds);
  timer.unref();
  return () => clearTimeout(timer);
}

type DeleteStorageObjectOptions = {
  readonly storageObjectId: string;
  readonly requestedAt: Date;
  readonly transactionRunner: StorageTransactionRunner;
  readonly createRepository: StorageObjectRepositoryFactory;
  readonly publisher: CleanupIntentPublisher;
  readonly removeReferences: (executor: QueryExecutor) => Promise<void>;
};

export async function requestStorageObjectDeletion(options: DeleteStorageObjectOptions) {
  const storageObjectId = options.storageObjectId;
  const requestedAt = ownDeletionDate(options.requestedAt);
  const transactionRunner = options.transactionRunner;
  const createRepository = options.createRepository;
  const publisher = options.publisher;
  const removeReferences = options.removeReferences;
  return transactionRunner(async (executor) => {
    await removeReferences(executor);
    const object = await createRepository(executor).markDeletePending(storageObjectId, requestedAt);
    await publisher.publish(executor, createCleanupIntent(object, "delete_pending"));
    return object;
  });
}

export async function deleteStorageObjectBytes(
  storage: StorageAdapter,
  target: { readonly driver: StorageDriver; readonly objectKey: string }
): Promise<{ readonly outcome: "deleted" | "already_missing" }> {
  if (target.driver !== storage.driver) {
    throw new StorageObjectServiceError("STORAGE_OBJECT_DRIVER_MISMATCH", "Configured storage driver does not own this object");
  }
  try {
    await storage.delete(target.objectKey);
    return { outcome: "deleted" };
  } catch (error) {
    if (error instanceof StorageError && error.code === "OBJECT_NOT_FOUND") {
      return { outcome: "already_missing" };
    }
    throw error;
  }
}

function normalizeMediaType(mediaType: string) {
  if (typeof mediaType !== "string" || /[\u0000-\u001f\u007f]/.test(mediaType)) {
    throw new StorageObjectServiceError("INVALID_STORAGE_OBJECT_MEDIA_TYPE", "Invalid storage object media type");
  }
  const normalized = mediaType.trim();
  if (!normalized || normalized.length > 255) {
    throw new StorageObjectServiceError("INVALID_STORAGE_OBJECT_MEDIA_TYPE", "Invalid storage object media type");
  }
  return normalized;
}

class PrewriteBodyMonitor {
  private readonly observedErrors: unknown[] = [];
  private observing = true;
  private readonly onError = (error: unknown) => {
    this.recordBodyError(error);
  };

  constructor(private readonly body: Readable) {
    body.on("error", this.onError);
  }

  assertReadyForStorage() {
    if (this.observedErrors.length > 0) throw this.observedErrors[0];
  }

  async finishStorageWrite(adapterFailed: boolean) {
    try {
      await this.observeDestroyTerminal();
    } finally {
      this.stopObserving();
    }
    if (adapterFailed || this.observedErrors.length === 0) return;
    throw new StorageError("STORAGE_IO_ERROR", "Storage input stream failed", {
      cause: this.observedErrors[0]
    });
  }

  async destroyAndReport(primaryError: unknown) {
    try {
      if (!this.body.destroyed) {
        try {
          this.body.destroy();
        } catch (cleanupError) {
          this.recordBodyError(cleanupError);
        }
      }
      await this.observeDestroyTerminal();
    } finally {
      this.stopObserving();
    }

    const cleanupErrors = this.observedErrors.filter((error) => !Object.is(error, primaryError));
    if (cleanupErrors.length === 0) return;
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      "STORAGE_OBJECT_PREWRITE_CLEANUP_FAILED",
      { cause: primaryError }
    );
  }

  private async observeDestroyTerminal() {
    while (this.body.destroyed && !this.body.closed) {
      await nextImmediate();
    }
    // A synchronous _destroy callback marks the stream closed before Node's
    // queued error notification. Keep ownership through that notification and
    // bridge events already queued when an adapter settles.
    await nextImmediate();
  }

  private recordBodyError(error: unknown) {
    const ownedError = error instanceof Error ? error : new Error("STORAGE_BODY_CLEANUP_FAILED");
    if (!this.observedErrors.some((candidate) => Object.is(candidate, ownedError))) {
      this.observedErrors.push(ownedError);
    }
  }

  private stopObserving() {
    if (!this.observing) return;
    this.observing = false;
    this.body.removeListener("error", this.onError);
  }
}

function nextImmediate() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function ownDeletionDate(value: Date) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new StorageObjectRepositoryError("INVALID_STORAGE_OBJECT_DATE", "Invalid storage object date");
  }
  return new Date(value.getTime());
}
