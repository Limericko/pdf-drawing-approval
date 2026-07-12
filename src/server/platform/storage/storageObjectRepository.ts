import type { StorageDriver } from "./storageAdapter.ts";

export type StorageObjectStatus = "staging" | "ready" | "delete_pending" | "deleted" | "failed";

export type StorageObject = {
  readonly id: string;
  readonly status: StorageObjectStatus;
  readonly driver: StorageDriver;
  readonly objectKey: string;
  readonly sizeBytes: number | null;
  readonly sha256: Buffer | null;
  readonly mediaType: string | null;
  readonly lastError: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly readyAt: Date | null;
  readonly deleteRequestedAt: Date | null;
  readonly deletedAt: Date | null;
  readonly uploadExpiresAt: Date | null;
  readonly cleanupTombstone: boolean;
  readonly cleanupGeneration: number;
  readonly cleanupNotBefore: Date | null;
};

export type CreateStagingStorageObject = Pick<StorageObject, "id" | "driver" | "objectKey" | "createdAt"> & {
  readonly uploadExpiresAt: Date;
};

export type ReadyStorageObjectContent = {
  readonly sizeBytes: number;
  readonly sha256: Buffer;
  readonly mediaType: string;
  readonly readyAt: Date;
};

export type PrepareStorageCleanup = {
  readonly id: string;
  readonly expectedStatus: Extract<StorageObjectStatus, "staging" | "delete_pending">;
  readonly driver: StorageDriver;
  readonly objectKey: string;
  readonly requestedAt: Date;
  readonly cleanupGeneration: number;
};

export type CompleteStorageCleanup = Pick<PrepareStorageCleanup, "id" | "driver" | "objectKey"> & {
  readonly expectedGeneration: number;
  readonly deletedAt: Date;
};

export type ScheduleStorageCleanupReap = Pick<PrepareStorageCleanup, "id" | "driver" | "objectKey"> & {
  readonly expectedGeneration: number;
  readonly scheduledAt: Date;
  readonly nextCleanupAt: Date;
  readonly lastError: string | null;
};

export interface StorageObjectRepository {
  createStaging(input: CreateStagingStorageObject): Promise<StorageObject>;
  findById(id: string): Promise<StorageObject | undefined>;
  markReady(id: string, content: ReadyStorageObjectContent): Promise<StorageObject>;
  markDeletePending(id: string, requestedAt: Date): Promise<StorageObject>;
  listStaleStaging(createdBefore: Date, limit: number): Promise<StorageObject[]>;
  listDeletePending(dueAt: Date, limit: number): Promise<StorageObject[]>;
  prepareCleanup(input: PrepareStorageCleanup): Promise<StorageObject | undefined>;
  completeCleanup(input: CompleteStorageCleanup): Promise<StorageObject | undefined>;
  scheduleCleanupReap(input: ScheduleStorageCleanupReap): Promise<StorageObject | undefined>;
}

export type StorageObjectRepositoryErrorCode =
  | "INVALID_STORAGE_OBJECT_ID"
  | "INVALID_STORAGE_OBJECT_DRIVER"
  | "INVALID_STORAGE_OBJECT_CONTENT"
  | "INVALID_STORAGE_OBJECT_DATE"
  | "INVALID_STORAGE_OBJECT_DATE_ORDER"
  | "INVALID_STORAGE_OBJECT_LIMIT"
  | "STORAGE_OBJECT_NOT_FOUND"
  | "STORAGE_OBJECT_STATE_CONFLICT"
  | "STORAGE_OBJECT_UPLOAD_EXPIRED"
  | "STORAGE_OBJECT_SIZE_OUT_OF_RANGE";

export class StorageObjectRepositoryError extends Error {
  constructor(readonly code: StorageObjectRepositoryErrorCode, message: string) {
    super(message);
    this.name = "StorageObjectRepositoryError";
  }
}
