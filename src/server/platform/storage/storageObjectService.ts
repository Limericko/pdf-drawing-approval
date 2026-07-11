import type { Readable } from "node:stream";
import { v7 as uuidv7 } from "uuid";
import type { QueryExecutor } from "../database/queryExecutor.ts";
import { createCleanupIntent, type CleanupIntentPublisher } from "./cleanupIntentPublisher.ts";
import type { StorageAdapter, StorageDriver } from "./storageAdapter.ts";
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
  | "STORAGE_OBJECT_HEAD_MISMATCH";

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
};

export class StorageObjectService {
  private readonly createId: () => string;
  private readonly clock: () => Date;

  constructor(private readonly dependencies: StorageObjectServiceDependencies) {
    this.createId = dependencies.createId ?? uuidv7;
    this.clock = dependencies.clock ?? (() => new Date());
  }

  async create(input: { readonly body: Readable; readonly mediaType: string }): Promise<StorageObject> {
    const body = input.body;
    const rawMediaType = input.mediaType;
    let writeStarted = false;
    try {
      const mediaType = normalizeMediaType(rawMediaType);
      const id = this.createId();
      const objectKey = createStorageKey("objects/original", id);
      const staged = await this.dependencies.transactionRunner((executor) =>
        this.dependencies.createRepository(executor).createStaging({
          id,
          driver: this.dependencies.storage.driver,
          objectKey,
          createdAt: this.now()
        })
      );
      this.assertCurrentDriver(staged.driver);

      writeStarted = true;
      const written = await this.dependencies.storage.write(staged.objectKey, body, mediaType);
      const head = await this.dependencies.storage.head(staged.objectKey);
      if (head === null || head.sizeBytes !== written.sizeBytes) {
        throw new StorageObjectServiceError("STORAGE_OBJECT_HEAD_MISMATCH", "Stored object size verification failed");
      }

      return this.dependencies.transactionRunner((executor) =>
        this.dependencies.createRepository(executor).markReady(staged.id, {
          sizeBytes: written.sizeBytes,
          sha256: Buffer.from(written.sha256),
          mediaType,
          readyAt: this.now()
        })
      );
    } catch (error) {
      if (!writeStarted) destroyUnownedBody(body, error);
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

function destroyUnownedBody(body: Readable, primaryError: unknown) {
  try {
    body.destroy();
  } catch (cleanupError) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "STORAGE_OBJECT_PREWRITE_CLEANUP_FAILED",
      { cause: primaryError }
    );
  }
}

function ownDeletionDate(value: Date) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new StorageObjectRepositoryError("INVALID_STORAGE_OBJECT_DATE", "Invalid storage object date");
  }
  return new Date(value.getTime());
}
