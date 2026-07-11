import type { QueryExecutor } from "../database/queryExecutor.ts";
import type { StorageDriver } from "./storageAdapter.ts";
import type { StorageObject, StorageObjectStatus } from "./storageObjectRepository.ts";

export type CleanupIntentStatus = Extract<StorageObjectStatus, "staging" | "delete_pending">;

export type CleanupIntent = {
  readonly type: "storage_object_cleanup";
  readonly payloadVersion: 1;
  readonly idempotencyKey: string;
  readonly storageObjectId: string;
  readonly expectedStatus: CleanupIntentStatus;
  readonly driver: StorageDriver;
  readonly objectKey: string;
};

export interface CleanupIntentPublisher {
  publish(executor: QueryExecutor, intent: CleanupIntent): Promise<void>;
}

export function createCleanupIntent(
  object: Pick<StorageObject, "id" | "driver" | "objectKey">,
  expectedStatus: CleanupIntentStatus
): CleanupIntent {
  return Object.freeze({
    type: "storage_object_cleanup",
    payloadVersion: 1,
    idempotencyKey: `storage-object-cleanup:${object.id}:${expectedStatus}`,
    storageObjectId: object.id,
    expectedStatus,
    driver: object.driver,
    objectKey: object.objectKey
  });
}
