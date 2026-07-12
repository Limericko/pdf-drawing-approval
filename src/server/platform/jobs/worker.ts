import type { JobRepository } from "./jobRepository.ts";
import type { Job } from "./jobTypes.ts";
import type { RetryPolicy } from "./retryPolicy.ts";
import { JobHandlerError, type JobRegistry } from "./jobRegistry.ts";

export type WorkerState = { nextReconcileAt: Date };

type Dispatcher = { dispatchBatch(limit: number): Promise<number> };
type Reconciler = { runOnce(): Promise<{ published: number }> };
type Heartbeat = { record(input: { workerId: string; startedAt: Date; heartbeatAt: Date; metadata: Record<string, unknown> }): Promise<unknown> };
type Sleep = (milliseconds: number, signal: AbortSignal) => Promise<void>;

export type WorkerIterationOptions = {
  readonly workerId: string;
  readonly startedAt?: Date;
  readonly state: WorkerState;
  readonly repository: JobRepository;
  readonly registry: JobRegistry;
  readonly dispatcher: Dispatcher;
  readonly dispatchBatchSize: number;
  readonly reconciler: Reconciler;
  readonly reconcileIntervalMs: number;
  readonly heartbeat: Heartbeat;
  readonly retryPolicy: RetryPolicy;
  readonly clock: () => Date;
  readonly leaseMs: number;
  readonly renewIntervalMs: number;
  readonly leaseSleep?: Sleep;
  readonly signal: AbortSignal;
};

export type WorkerOptions = WorkerIterationOptions & {
  readonly idleSleepMs: number;
  readonly sleep?: Sleep;
};

export async function runWorkerIteration(options: WorkerIterationOptions): Promise<
  { status: "stopped" | "idle" } | { status: "processed"; jobId: string; outcome: "succeeded" | "failed" | "stale" }
> {
  const owned = ownIterationOptions(options);
  if (owned.signal.aborted) return { status: "stopped" };
  const heartbeatAt = owned.clock();
  await owned.heartbeat.record({
    workerId: owned.workerId,
    startedAt: owned.startedAt,
    heartbeatAt,
    metadata: { state: "active" }
  });
  if (owned.signal.aborted) return { status: "stopped" };
  await owned.dispatcher.dispatchBatch(owned.dispatchBatchSize);
  if (owned.signal.aborted) return { status: "stopped" };

  const reconcileNow = owned.clock();
  if (reconcileNow.getTime() >= owned.state.nextReconcileAt.getTime()) {
    await owned.reconciler.runOnce();
    owned.state.nextReconcileAt = addMilliseconds(reconcileNow, owned.reconcileIntervalMs);
  }
  if (owned.signal.aborted) return { status: "stopped" };

  const claimed = await owned.repository.claim({ workerId: owned.workerId, now: owned.clock(), leaseDurationMs: owned.leaseMs });
  if (!claimed) return { status: "idle" };
  if (owned.signal.aborted) {
    await owned.repository.release({
      id: claimed.id,
      workerId: owned.workerId,
      leaseToken: claimed.leaseToken!,
      releasedAt: owned.clock()
    });
    return { status: "stopped" };
  }
  return executeClaimedJob(owned, claimed);
}

export async function runWorker(options: WorkerOptions): Promise<void> {
  const owned = ownWorkerOptions(options);
  while (!owned.signal.aborted) {
    const result = await runWorkerIteration(owned);
    if (result.status === "stopped" || owned.signal.aborted) break;
    if (result.status === "idle") await owned.sleep(owned.idleSleepMs, owned.signal);
  }
}

async function executeClaimedJob(options: OwnedIterationOptions, job: Job) {
  const lease = { id: job.id, workerId: options.workerId, leaseToken: job.leaseToken! };
  const renewal = startRenewalPump(options, lease);
  let failure: JobHandlerError | undefined;
  try {
    const handler = options.registry.resolve(job);
    await handler(job);
  } catch (error) {
    failure = classifyHandlerError(error);
  } finally {
    renewal.stop();
    await renewal.done;
  }

  if (renewal.error !== undefined) throw renewal.error;
  if (renewal.leaseLost) return { status: "processed" as const, jobId: job.id, outcome: "stale" as const };
  const transitionAt = options.clock();
  try {
    if (!failure) {
      await options.repository.succeed({ ...lease, completedAt: transitionAt });
      return { status: "processed" as const, jobId: job.id, outcome: "succeeded" as const };
    }
    const retry = failure.kind === "transient" ? options.retryPolicy.next(job.attemptCount) : undefined;
    await options.repository.fail({
      ...lease,
      failedAt: transitionAt,
      kind: failure.kind,
      errorCode: failure.code,
      errorMessage: failure.message,
      ...(retry ? { nextRunAt: retry.nextRunAt } : {})
    });
    return { status: "processed" as const, jobId: job.id, outcome: "failed" as const };
  } catch (error) {
    if (isStaleLease(error)) return { status: "processed" as const, jobId: job.id, outcome: "stale" as const };
    throw error;
  }
}

function startRenewalPump(options: OwnedIterationOptions, lease: { id: string; workerId: string; leaseToken: string }) {
  const controller = new AbortController();
  let leaseLost = false;
  let renewalError: unknown;
  const done = (async () => {
    while (!controller.signal.aborted) {
      try {
        await options.leaseSleep(options.renewIntervalMs, controller.signal);
      } catch (error) {
        renewalError = error;
        leaseLost = true;
        break;
      }
      if (controller.signal.aborted) break;
      try {
        await options.repository.renewLease({ ...lease, now: options.clock(), leaseDurationMs: options.leaseMs });
      } catch (error) {
        leaseLost = true;
        if (!isStaleLease(error)) renewalError = error;
        break;
      }
    }
  })();
  return {
    stop: () => controller.abort(),
    done,
    get leaseLost() { return leaseLost; },
    get error() { return renewalError; }
  };
}

type OwnedIterationOptions = Omit<WorkerIterationOptions, "startedAt" | "leaseSleep"> & { startedAt: Date; leaseSleep: Sleep };

function ownIterationOptions(options: WorkerIterationOptions): OwnedIterationOptions {
  if (!options || typeof options !== "object" || typeof options.workerId !== "string" || !options.workerId ||
      options.workerId !== options.workerId.trim() || options.workerId.length > 255 || /[\u0000-\u001f\u007f]/.test(options.workerId) ||
      typeof options.clock !== "function" || !options.signal || typeof options.signal.aborted !== "boolean") throw invalidWorker();
  assertInteger(options.dispatchBatchSize, 1, 1_000);
  assertInteger(options.reconcileIntervalMs, 1, 86_400_000);
  assertInteger(options.leaseMs, 2, 3_600_000);
  assertInteger(options.renewIntervalMs, 1, options.leaseMs - 1);
  if (options.renewIntervalMs * 2 >= options.leaseMs) throw invalidWorker();
  const startedAt = ownDate(options.startedAt ?? options.clock());
  options.state.nextReconcileAt = ownDate(options.state.nextReconcileAt);
  return { ...options, startedAt, leaseSleep: options.leaseSleep ?? abortableSleep };
}

function ownWorkerOptions(options: WorkerOptions): OwnedIterationOptions & Pick<WorkerOptions, "idleSleepMs"> & { sleep: Sleep } {
  const iteration = ownIterationOptions(options);
  assertInteger(options.idleSleepMs, 1, 60_000);
  if (options.sleep !== undefined && typeof options.sleep !== "function") throw invalidWorker();
  return { ...iteration, idleSleepMs: options.idleSleepMs, sleep: options.sleep ?? abortableSleep };
}

export function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

function classifyHandlerError(error: unknown) {
  if (error instanceof JobHandlerError) return error;
  return new JobHandlerError("transient", "HANDLER_FAILED", "Job handler failed");
}

function isStaleLease(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "STALE_LEASE");
}

function addMilliseconds(date: Date, milliseconds: number) {
  const value = date.getTime() + milliseconds;
  if (!Number.isSafeInteger(value) || Math.abs(value) > 8_640_000_000_000_000) throw invalidWorker();
  return new Date(value);
}

function ownDate(value: Date) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw invalidWorker();
  return new Date(value.getTime());
}

function assertInteger(value: number, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw invalidWorker();
}

function invalidWorker() {
  return new Error("INVALID_WORKER_OPTIONS");
}
