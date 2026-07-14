export type AuditResult = "success" | "failure" | "denied" | "error";
export type AuditMetadataKey =
  | "reason"
  | "ipPrefix"
  | "userAgent"
  | "projectId"
  | "documentId"
  | "revisionId"
  | "approvalId"
  | "issueId"
  | "partId"
  | "sessionId"
  | "jobId"
  | "backupRunId"
  | "mfaMethod"
  | "reviewerRole"
  | "oldStatus"
  | "newStatus"
  | "provider"
  | "count";
export type AuditMetadataValue = string | number | boolean | null;
export type AuditMetadata = Readonly<Partial<Record<AuditMetadataKey, AuditMetadataValue>>>;

export type AuditEvent = {
  readonly id: string;
  readonly occurredAt: Date;
  readonly actorUserId: string | null;
  readonly actorType: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly requestId: string;
  readonly result: AuditResult;
  readonly metadata: AuditMetadata;
};

export type AppendAuditEventInput = Omit<AuditEvent, "id" | "occurredAt">;
export type ListAuditEventsInput = {
  readonly actorUserId?: string;
  readonly requestId?: string;
  readonly targetType?: string;
  readonly targetId?: string;
  readonly beforeOccurredAt?: Date;
  readonly limit?: number;
};

export interface AuditRepository {
  append(input: AppendAuditEventInput): Promise<AuditEvent>;
  appendOnly(input: AppendAuditEventInput): Promise<void>;
  list(input?: ListAuditEventsInput): Promise<readonly AuditEvent[]>;
}
