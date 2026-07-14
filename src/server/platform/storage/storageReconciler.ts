import { createCleanupIntent, type CleanupIntentPublisher } from "./cleanupIntentPublisher.ts";
import type { StorageObject, StorageObjectRepository } from "./storageObjectRepository.ts";
import type { StorageObjectRepositoryFactory, StorageTransactionRunner } from "./storageObjectService.ts";

type StorageReconcilerOptions = {
  readonly transactionRunner: StorageTransactionRunner;
  readonly createRepository: StorageObjectRepositoryFactory;
  readonly publisher: CleanupIntentPublisher;
  readonly reapTombstone?: (signal: AbortSignal) => Promise<unknown>;
  readonly clock?: () => Date;
  readonly batchSize: number;
  readonly orphanReadyGraceMs?: number;
};

export class StorageReconciler {
  private readonly clock: () => Date;
  private readonly transactionRunner: StorageTransactionRunner;
  private readonly createRepository: StorageObjectRepositoryFactory;
  private readonly publisher: CleanupIntentPublisher;
  private readonly reapTombstone: ((signal: AbortSignal) => Promise<unknown>) | undefined;
  private readonly batchSize: number;
  private readonly orphanReadyGraceMs: number | undefined;
  private nextSinglePriority: "staging" | "delete_pending" = "staging";

  constructor(options: StorageReconcilerOptions) {
    if (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 1_000) {
      throw new Error("INVALID_STORAGE_RECONCILER_BATCH_SIZE");
    }
    this.clock = options.clock ?? (() => new Date());
    this.transactionRunner = options.transactionRunner;
    this.createRepository = options.createRepository;
    this.publisher = options.publisher;
    if (options.reapTombstone !== undefined && typeof options.reapTombstone !== "function") {
      throw new Error("INVALID_STORAGE_TOMBSTONE_REAPER");
    }
    this.reapTombstone = options.reapTombstone;
    this.batchSize = options.batchSize;
    if (options.orphanReadyGraceMs !== undefined && (!Number.isSafeInteger(options.orphanReadyGraceMs) ||
        options.orphanReadyGraceMs < 3_600_000 || options.orphanReadyGraceMs > 30 * 24 * 60 * 60_000)) {
      throw new Error("INVALID_STORAGE_ORPHAN_GRACE_MS");
    }
    this.orphanReadyGraceMs = options.orphanReadyGraceMs;
  }

  async runOnce(signal: AbortSignal = new AbortController().signal) {
    if (!signal || typeof signal.aborted !== "boolean") throw new Error("INVALID_STORAGE_RECONCILER_SIGNAL");
    const now = this.clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("INVALID_STORAGE_RECONCILER_CLOCK");
    const singlePriority = this.nextSinglePriority;

    const result = await this.transactionRunner(async (executor) => {
      const repository = this.createRepository(executor);
      const selected = this.batchSize === 1
        ? await selectSingle(repository, now, singlePriority)
        : await selectFairBatch(repository, now, this.batchSize);
      const stale = selected.filter((object) => object.status === "staging");
      const pending = selected.filter((object) => object.status === "delete_pending");
      const orphanCutoff = this.orphanReadyGraceMs === undefined ? undefined :
        new Date(now.getTime() - this.orphanReadyGraceMs);
      const orphans = orphanCutoff && repository.listReadyOrphans
        ? await repository.listReadyOrphans(orphanCutoff, this.batchSize) : [];
      for (const object of stale) {
        await this.publisher.publish(executor, createCleanupIntent(object, "staging"));
      }
      for (const object of pending) {
        await this.publisher.publish(executor, createCleanupIntent(object, "delete_pending"));
      }
      for (const orphan of orphans) {
        const pendingOrphan = await repository.markDeletePending(orphan.id, now);
        await this.publisher.publish(executor, createCleanupIntent(pendingOrphan, "delete_pending"));
      }
      return { published: stale.length + pending.length + orphans.length, orphaned: orphans.length };
    });
    if (this.batchSize === 1) {
      this.nextSinglePriority = singlePriority === "staging" ? "delete_pending" : "staging";
    }
    if (!signal.aborted && this.reapTombstone) await this.reapTombstone(signal);
    return this.orphanReadyGraceMs === undefined
      ? { published: result.published }
      : { published: result.published, orphaned: result.orphaned };
  }
}

async function selectSingle(
  repository: StorageObjectRepository,
  cutoff: Date,
  priority: "staging" | "delete_pending"
): Promise<StorageObject[]> {
  const primary = priority === "staging"
    ? await repository.listStaleStaging(cutoff, 1)
    : await repository.listDeletePending(cutoff, 1);
  if (primary.length > 0) return primary;
  return priority === "staging"
    ? repository.listDeletePending(cutoff, 1)
    : repository.listStaleStaging(cutoff, 1);
}

async function selectFairBatch(
  repository: StorageObjectRepository,
  cutoff: Date,
  batchSize: number
): Promise<StorageObject[]> {
  const staleCandidates = await repository.listStaleStaging(cutoff, batchSize);
  const pendingCandidates = await repository.listDeletePending(cutoff, batchSize);
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
