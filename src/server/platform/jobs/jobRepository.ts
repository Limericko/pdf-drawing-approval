import type { CreateJob, Job, JobLease } from "./jobTypes.ts";

export type CreateJobResult = { readonly created: boolean; readonly job: Job };

export type ClaimJobInput = {
  readonly workerId: string;
  readonly now: Date;
  readonly leaseDurationMs: number;
};

export type RenewJobLeaseInput = JobLease & {
  readonly now: Date;
  readonly leaseDurationMs: number;
};

export type CompleteJobInput = JobLease & { readonly completedAt: Date };

export type FailJobInput = JobLease & {
  readonly failedAt: Date;
  readonly kind: "transient" | "permanent";
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly nextRunAt?: Date;
};

export interface JobRepository {
  create(input: CreateJob): Promise<CreateJobResult>;
  findById(id: string): Promise<Job | undefined>;
  claim(input: ClaimJobInput): Promise<Job | null>;
  renewLease(input: RenewJobLeaseInput): Promise<Job>;
  succeed(input: CompleteJobInput): Promise<Job>;
  fail(input: FailJobInput): Promise<Job>;
}
