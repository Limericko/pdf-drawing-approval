import type { DispatchJobMapping } from "./dispatcher.ts";
import { cloneJsonObject, type Job, type OutboxEvent } from "./jobTypes.ts";

const MAX_ERROR_MESSAGE = 500;

export type JobHandler = (job: Job) => Promise<void>;

export type EventRegistration = {
  readonly eventType: string;
  readonly payloadVersion: number;
  readonly handlerVersion: string;
  readonly jobType: string;
  readonly jobPayloadVersion: number;
  readonly maxAttempts: number;
  readonly mapPayload?: (event: OutboxEvent) => Job["payload"];
};

export type HandlerRegistration = {
  readonly jobType: string;
  readonly payloadVersion: number;
  readonly handler: JobHandler;
};

export class JobHandlerError extends Error {
  constructor(
    readonly kind: "transient" | "permanent",
    readonly code: string,
    message: string
  ) {
    assertError(kind, code, message);
    super(message);
    this.name = "JobHandlerError";
  }
}

export class JobRegistryError extends JobHandlerError {
  constructor(code: "UNKNOWN_OUTBOX_EVENT" | "UNKNOWN_JOB_HANDLER" | "INVALID_JOB_REGISTRATION") {
    super("permanent", code, safeMessage(code));
    this.name = "JobRegistryError";
  }
}

export class JobRegistry {
  private readonly events = new Map<string, Readonly<EventRegistration>>();
  private readonly handlers = new Map<string, JobHandler>();

  constructor(events: readonly EventRegistration[], handlers: readonly HandlerRegistration[]) {
    if (!Array.isArray(events) || !Array.isArray(handlers)) throw invalidRegistration();
    for (const registration of events) {
      validateEventRegistration(registration);
      const key = versionKey(registration.eventType, registration.payloadVersion);
      if (this.events.has(key)) throw invalidRegistration();
      this.events.set(key, Object.freeze({ ...registration }));
    }
    for (const registration of handlers) {
      validateHandlerRegistration(registration);
      const key = versionKey(registration.jobType, registration.payloadVersion);
      if (this.handlers.has(key)) throw invalidRegistration();
      this.handlers.set(key, registration.handler);
    }
  }

  mapEvent = (event: OutboxEvent): DispatchJobMapping => {
    const registration = this.events.get(versionKey(event.eventType, event.payloadVersion));
    if (!registration) throw new JobRegistryError("UNKNOWN_OUTBOX_EVENT");
    const payload = registration.mapPayload?.(event) ?? event.payload;
    return Object.freeze({
      handlerVersion: registration.handlerVersion,
      jobType: registration.jobType,
      payloadVersion: registration.jobPayloadVersion,
      payload: cloneJsonObject(payload, invalidRegistration),
      maxAttempts: registration.maxAttempts
    });
  };

  resolve(job: Pick<Job, "jobType" | "payloadVersion">): JobHandler {
    const handler = this.handlers.get(versionKey(job.jobType, job.payloadVersion));
    if (!handler) throw new JobRegistryError("UNKNOWN_JOB_HANDLER");
    return handler;
  }
}

export function storageCleanupEventRegistration(maxAttempts: number): EventRegistration {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) throw invalidRegistration();
  return Object.freeze({
    eventType: "storage_object_cleanup",
    payloadVersion: 1,
    handlerVersion: "v1",
    jobType: "storage_object_cleanup",
    jobPayloadVersion: 1,
    maxAttempts
  });
}

export function invitationEmailEventRegistration(maxAttempts: number): EventRegistration {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) throw invalidRegistration();
  return Object.freeze({
    eventType: "invitation.created", payloadVersion: 1, handlerVersion: "v1",
    jobType: "invitation.email", jobPayloadVersion: 1, maxAttempts,
    mapPayload(event) {
      const id = event.payload.invitationId;
      if (Object.keys(event.payload).length !== 1 || typeof id !== "string") throw invalidRegistration();
      return { invitationId: id };
    }
  });
}

function validateEventRegistration(value: EventRegistration) {
  if (!value || typeof value !== "object") throw invalidRegistration();
  assertName(value.eventType, 128);
  assertName(value.handlerVersion, 64);
  assertName(value.jobType, 128);
  assertPositiveInteger(value.payloadVersion);
  assertPositiveInteger(value.jobPayloadVersion);
  if (!Number.isSafeInteger(value.maxAttempts) || value.maxAttempts < 1 || value.maxAttempts > 100) throw invalidRegistration();
  if (value.mapPayload !== undefined && typeof value.mapPayload !== "function") throw invalidRegistration();
}

function validateHandlerRegistration(value: HandlerRegistration) {
  if (!value || typeof value !== "object") throw invalidRegistration();
  assertName(value.jobType, 128);
  assertPositiveInteger(value.payloadVersion);
  if (typeof value.handler !== "function") throw invalidRegistration();
}

function versionKey(name: string, version: number) {
  return `${name}\u0000${version}`;
}

function assertName(value: string, maximum: number) {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > maximum || /[\u0000-\u0020\u007f:]/.test(value)) throw invalidRegistration();
}

function assertPositiveInteger(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) throw invalidRegistration();
}

function assertError(kind: string, code: string, message: string) {
  if ((kind !== "transient" && kind !== "permanent") || typeof code !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/.test(code) ||
      typeof message !== "string" || !message || message !== message.trim() || message.length > MAX_ERROR_MESSAGE || /[\u0000-\u001f\u007f]/.test(message)) {
    throw invalidRegistration();
  }
}

function safeMessage(code: string) {
  if (code === "UNKNOWN_OUTBOX_EVENT") return "No registered mapping for outbox event";
  if (code === "UNKNOWN_JOB_HANDLER") return "No registered handler for job";
  return "Invalid static job registration";
}

function invalidRegistration() {
  return new Error("INVALID_JOB_REGISTRATION");
}
