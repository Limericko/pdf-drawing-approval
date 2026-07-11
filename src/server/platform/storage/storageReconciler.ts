import { createCleanupIntent, type CleanupIntentPublisher } from "./cleanupIntentPublisher.ts";
import type { StorageObject, StorageObjectRepository } from "./storageObjectRepository.ts";
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
  private readonly transactionRunner: StorageTransactionRunner;
  private readonly createRepository: StorageObjectRepositoryFactory;
  private readonly publisher: CleanupIntentPublisher;
  private readonly stagingMaxAgeMs: number;
  private readonly batchSize: number;
  private nextSinglePriority: "staging" | "delete_pending" = "staging";

  constructor(options: StorageReconcilerOptions) {
    if (!Number.isSafeInteger(options.stagingMaxAgeMs) || options.stagingMaxAgeMs < 1) {
      throw new Error("INVALID_STORAGE_RECONCILER_STAGING_MAX_AGE");
    }
    if (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 1_000) {
      throw new Error("INVALID_STORAGE_RECONCILER_BATCH_SIZE");
    }
    this.clock = options.clock ?? (() => new Date());
    this.transactionRunner = options.transactionRunner;
    this.createRepository = options.createRepository;
    this.publisher = options.publisher;
    this.stagingMaxAgeMs = options.stagingMaxAgeMs;
    this.batchSize = options.batchSize;
  }

  async runOnce() {
    const now = this.clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("INVALID_STORAGE_RECONCILER_CLOCK");
    const cutoff = new Date(now.getTime() - this.stagingMaxAgeMs);
    const singlePriority = this.nextSinglePriority;

    const result = await this.transactionRunner(async (executor) => {
      const repository = this.createRepository(executor);
      const selected = this.batchSize === 1
        ? await selectSingle(repository, cutoff, singlePriority)
        : await selectFairBatch(repository, cutoff, this.batchSize);
      const stale = selected.filter((object) => object.status === "staging");
      const pending = selected.filter((object) => object.status === "delete_pending");
      for (const object of stale) {
        await this.publisher.publish(executor, createCleanupIntent(object, "staging"));
      }
      for (const object of pending) {
        await this.publisher.publish(executor, createCleanupIntent(object, "delete_pending"));
      }
      return { published: selected.length };
    });
    if (this.batchSize === 1) {
      this.nextSinglePriority = singlePriority === "staging" ? "delete_pending" : "staging";
    }
    return result;
  }
}

async function selectSingle(
  repository: StorageObjectRepository,
  cutoff: Date,
  priority: "staging" | "delete_pending"
): Promise<StorageObject[]> {
  const primary = priority === "staging"
    ? await repository.listStaleStaging(cutoff, 1)
    : await repository.listDeletePending(1);
  if (primary.length > 0) return primary;
  return priority === "staging"
    ? repository.listDeletePending(1)
    : repository.listStaleStaging(cutoff, 1);
}

async function selectFairBatch(
  repository: StorageObjectRepository,
  cutoff: Date,
  batchSize: number
): Promise<StorageObject[]> {
  const staleCandidates = await repository.listStaleStaging(cutoff, batchSize);
  const pendingCandidates = await repository.listDeletePending(batchSize);
  const staleQuota = Math.ceil(batchSize / 2);
  const pendingQuota = Math.floor(batchSize / 2);
  const stale = staleCandidates.slice(0, staleQuota);
  const pending = pendingCandidates.slice(0, pendingQuota);
  let remaining = batchSize - stale.length - pending.length;
  if (remaining > 0) {
    const extraStale = staleCandidates.slice(stale.length, stale.length + remaining);
    stale.push(...extraStale);
    remaining -= extraStale.length;
  }
  if (remaining > 0) {
    pending.push(...pendingCandidates.slice(pending.length, pending.length + remaining));
  }
  return [...stale, ...pending];
}
