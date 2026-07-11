export type DatabaseErrorClassification =
  | {
      readonly kind: "connection" | "serialization_failure" | "deadlock_detected";
      readonly transient: true;
      readonly retryable: true;
    }
  | {
      readonly kind: "unknown";
      readonly transient: false;
      readonly retryable: false;
    };

const CONNECTION_ERROR_CODES = new Set([
  "08000",
  "08001",
  "08003",
  "08006",
  "57P01",
  "57P02",
  "57P03",
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ENETDOWN",
  "ENETUNREACH",
  "EHOSTUNREACH"
]);

export function classifyDatabaseError(error: unknown): DatabaseErrorClassification {
  const code = errorCode(error);
  if (code && CONNECTION_ERROR_CODES.has(code)) {
    return { kind: "connection", transient: true, retryable: true };
  }
  if (code === "40001") {
    return { kind: "serialization_failure", transient: true, retryable: true };
  }
  if (code === "40P01") {
    return { kind: "deadlock_detected", transient: true, retryable: true };
  }
  return { kind: "unknown", transient: false, retryable: false };
}

function errorCode(error: unknown) {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
