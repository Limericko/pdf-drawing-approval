import type { QueryExecutor } from "../database/queryExecutor.ts";
import type { JobRepository } from "./jobRepository.ts";
import type { JsonObject, OutboxEvent } from "./jobTypes.ts";
import { JobRepositoryError } from "./jobTypes.ts";
import type { OutboxRepository } from "./outboxRepository.ts";

type TransactionRunner = <T>(callback: (executor: QueryExecutor) => Promise<T>) => Promise<T>;

export type DispatchJobMapping = {
  readonly handlerVersion: string;
  readonly jobType: string;
  readonly payloadVersion: number;
  readonly payload: JsonObject;
  readonly maxAttempts: number;
};

type DispatcherOptions = {
  readonly transactionRunner: TransactionRunner;
  readonly createOutboxRepository: (executor: QueryExecutor) => OutboxRepository;
  readonly createJobRepository: (executor: QueryExecutor) => JobRepository;
  readonly mapEvent: (event: OutboxEvent) => DispatchJobMapping;
  readonly createId: () => string;
  readonly clock: () => Date;
};

export class OutboxDispatcher {
  constructor(private readonly options: DispatcherOptions) {}

  async dispatchBatch(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new JobRepositoryError("INVALID_JOB_LIMIT", "Invalid dispatcher batch limit");
    }
    const dispatchedAt = ownDate(this.options.clock());
    return this.options.transactionRunner(async (transaction) => {
      const outbox = this.options.createOutboxRepository(transaction);
      const jobs = this.options.createJobRepository(transaction);
      const events = await outbox.claimUndispatched(limit);
      for (const event of events) {
        const mapping = this.options.mapEvent(event);
        assertMapping(mapping);
        const id = this.options.createId();
        await jobs.create({
          id,
          jobType: mapping.jobType,
          payloadVersion: mapping.payloadVersion,
          payload: mapping.payload,
          idempotencyKey: `outbox:${event.id}:${mapping.handlerVersion}`,
          maxAttempts: mapping.maxAttempts,
          nextRunAt: dispatchedAt,
          createdAt: dispatchedAt
        });
        await outbox.markDispatched(event.id, dispatchedAt);
      }
      return events.length;
    });
  }
}

function assertMapping(mapping: DispatchJobMapping) {
  if (
    !mapping || typeof mapping !== "object" ||
    typeof mapping.handlerVersion !== "string" || !mapping.handlerVersion ||
    mapping.handlerVersion !== mapping.handlerVersion.trim() || mapping.handlerVersion.length > 64 ||
    /[\u0000-\u0020\u007f:]/.test(mapping.handlerVersion)
  ) throw new JobRepositoryError("INVALID_JOB_INPUT", "Invalid outbox handler version");
}

function ownDate(value: Date) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new JobRepositoryError("INVALID_JOB_DATE", "Invalid dispatcher date");
  return new Date(value.getTime());
}
