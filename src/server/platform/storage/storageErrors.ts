export type StorageErrorCode =
  | "INVALID_STORAGE_KEY"
  | "INVALID_STORAGE_ROOT"
  | "OBJECT_EXISTS"
  | "OBJECT_NOT_FOUND"
  | "UNSAFE_STORAGE_PATH"
  | "STORAGE_IO_ERROR"
  | "STORAGE_HEALTH_CHECK_FAILED";

export class StorageError extends Error {
  readonly code: StorageErrorCode;

  constructor(code: StorageErrorCode, message: string, options?: ErrorOptions) {
    const cause = sanitizeCause(options?.cause);
    super(message, cause === undefined ? undefined : { cause });
    this.name = "StorageError";
    this.code = code;
  }
}

class StorageCauseError extends Error {
  readonly code?: string;
  readonly syscall?: string;

  constructor(cause: unknown) {
    super("Storage dependency failed");
    this.name = "StorageCauseError";
    this.code = safeCauseField(cause, "code", /^[A-Z0-9_]+$/i);
    this.syscall = safeCauseField(cause, "syscall", /^[a-z0-9_]+$/i);
  }
}

function sanitizeCause(cause: unknown): Error | undefined {
  if (cause === undefined) {
    return undefined;
  }
  if (cause instanceof StorageError) {
    return cause;
  }
  return new StorageCauseError(cause);
}

function safeCauseField(
  cause: unknown,
  field: "code" | "syscall",
  pattern: RegExp,
): string | undefined {
  if (typeof cause !== "object" || cause === null || !(field in cause)) {
    return undefined;
  }
  const value = (cause as Record<string, unknown>)[field];
  return typeof value === "string" && value.length <= 64 && pattern.test(value)
    ? value
    : undefined;
}
