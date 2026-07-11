import { createCleanupIntent, type CleanupIntentPublisher } from "./cleanupIntentPublisher.ts";
import type { StorageObjectRepositoryFactory, StorageTransactionRunner } from "./storageObjectService.ts";

type StorageReconcilerOptions = {
  readonly transactionRunner: StorageTransactionRunner;
  readonly createRepository: StorageObjectRepositoryFactory;
  readonly publisher: CleanupIntentPublisher;
  readonly clock?: () => Date;
  readonly stagingMaxAgeMs: number;
  readonly batchSize: number;
};

export class StorageReconciler {
  private readonly clock: () => Date;

  constructor(private readonly options: StorageReconcilerOptions) {
    if (!Number.isSafeInteger(options.stagingMaxAgeMs) || options.stagingMaxAgeMs < 1) {
      throw new Error("INVALID_STORAGE_RECONCILER_STAGING_MAX_AGE");
    }
    if (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 1_000) {
      throw new Error("INVALID_STORAGE_RECONCILER_BATCH_SIZE");
    }
    this.clock = options.clock ?? (() => new Date());
  }

  async runOnce() {
    const now = this.clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("INVALID_STORAGE_RECONCILER_CLOCK");
    const cutoff = new Date(now.getTime() - this.options.stagingMaxAgeMs);

    return this.options.transactionRunner(async (executor) => {
      const repository = this.options.createRepository(executor);
      const stale = await repository.listStaleStaging(cutoff, this.options.batchSize);
      const remaining = this.options.batchSize - stale.length;
      const pending = remaining > 0 ? await repository.listDeletePending(remaining) : [];
      for (const object of stale) {
        await this.options.publisher.publish(executor, createCleanupIntent(object, "staging"));
      }
      for (const object of pending) {
        await this.options.publisher.publish(executor, createCleanupIntent(object, "delete_pending"));
      }
      return { published: stale.length + pending.length };
    });
  }
}
