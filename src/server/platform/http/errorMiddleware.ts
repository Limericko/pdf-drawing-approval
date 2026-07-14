import type { ErrorRequestHandler } from "express";
import { classifyDatabaseError } from "../database/databaseErrors.ts";
import { HttpProblem, sendProblem } from "./problemResponse.ts";
import { createRequestId, safeRequestId } from "./requestContext.ts";

type SecurityLogger = {
  error(event: { readonly requestId: string; readonly userId?: string; readonly code: string }): void;
};

/** Final fallback contract: implementations are synchronous and must never throw. */
export type EmergencySink = (event: { readonly requestId: string; readonly code: "LOGGER_FAILURE" }) => void;

type ProblemMapping = { status: number; title: string };

const DOMAIN_PROBLEMS: Readonly<Record<string, ProblemMapping>> = Object.freeze({
  AUTHENTICATION_INPUT_INVALID: { status: 400, title: "Invalid request" },
  AUTHENTICATION_INVALID_CREDENTIALS: { status: 401, title: "Authentication required" },
  AUTHENTICATION_MFA_INVALID: { status: 401, title: "Authentication required" },
  AUTHENTICATION_RATE_LIMITED: { status: 429, title: "Too many requests" },
  AUTHENTICATION_SECURITY_DEPENDENCY_UNAVAILABLE: { status: 503, title: "Security service unavailable" },
  AUTHENTICATION_REQUIRED: { status: 401, title: "Authentication required" },
  SESSION_INPUT_INVALID: { status: 400, title: "Invalid request" },
  SESSION_INVALID: { status: 401, title: "Authentication required" },
  SESSION_SECURITY_DEPENDENCY_UNAVAILABLE: { status: 503, title: "Security service unavailable" },
  INVITATION_INVALID: { status: 400, title: "Invalid invitation" },
  INVITATION_RATE_LIMITED: { status: 429, title: "Too many requests" },
  INVITATION_PASSWORD_POLICY: { status: 422, title: "Password policy not met" },
  INVITATION_TOTP_INVALID: { status: 400, title: "Invalid verification code" },
  AUTHORIZATION_INPUT_INVALID: { status: 400, title: "Invalid request" },
  AUTHORIZATION_FORBIDDEN: { status: 403, title: "Forbidden" },
  PROJECT_NOT_FOUND: { status: 404, title: "Project not found" },
  AUTHORIZATION_DEPENDENCY_UNAVAILABLE: { status: 503, title: "Authorization service unavailable" },
  APPROVAL_INPUT_INVALID: { status: 400, title: "Invalid request" },
  APPROVAL_FORBIDDEN: { status: 403, title: "Forbidden" },
  APPROVAL_NOT_FOUND: { status: 404, title: "Approval not found" },
  APPROVAL_OBJECT_NOT_READY: { status: 409, title: "PDF object is not ready" },
  APPROVAL_STATE_CONFLICT: { status: 409, title: "Approval state changed" },
  APPROVAL_IDEMPOTENCY_CONFLICT: { status: 409, title: "Idempotency conflict" },
  OPEN_HIGH_SEVERITY_ISSUES: { status: 409, title: "Open high severity issues" },
  APPROVAL_DEPENDENCY_UNAVAILABLE: { status: 503, title: "Approval service unavailable" },
  TASK_INPUT_INVALID: { status: 400, title: "Invalid request" },
  TASK_PROJECT_NOT_FOUND: { status: 404, title: "Project not found" },
  TASK_DEPENDENCY_UNAVAILABLE: { status: 503, title: "Task service unavailable" },
  PDM_INPUT_INVALID: { status: 400, title: "Invalid request" },
  PDM_FORBIDDEN: { status: 403, title: "Forbidden" },
  PDM_NOT_FOUND: { status: 404, title: "Part not found" },
  PDM_STATE_CONFLICT: { status: 409, title: "PDM state changed" },
  PDM_IDEMPOTENCY_CONFLICT: { status: 409, title: "Idempotency conflict" },
  PDM_SOURCE_NOT_READY: { status: 409, title: "PDM source is not ready" },
  PDM_DEPENDENCY_UNAVAILABLE: { status: 503, title: "PDM service unavailable" },
  SIGNATURE_INPUT_INVALID: { status: 400, title: "Invalid request" },
  SIGNATURE_USER_NOT_FOUND: { status: 404, title: "User not found" },
  SIGNATURE_OBJECT_NOT_READY: { status: 409, title: "Signature image is not ready" },
  SIGNATURE_IDEMPOTENCY_CONFLICT: { status: 409, title: "Idempotency conflict" },
  SIGNATURE_DEPENDENCY_UNAVAILABLE: { status: 503, title: "Signature service unavailable" },
  ISSUE_INPUT_INVALID: { status: 400, title: "Invalid request" },
  ISSUE_FORBIDDEN: { status: 403, title: "Forbidden" },
  ISSUE_NOT_FOUND: { status: 404, title: "Issue not found" },
  ISSUE_STATE_CONFLICT: { status: 409, title: "Issue state changed" },
  ISSUE_IDEMPOTENCY_CONFLICT: { status: 409, title: "Idempotency conflict" },
  ISSUE_DEPENDENCY_UNAVAILABLE: { status: 503, title: "Issue service unavailable" },
  ADMIN_INPUT_INVALID: { status: 400, title: "Invalid request" },
  ADMIN_FORBIDDEN: { status: 403, title: "Forbidden" },
  ADMIN_NOT_FOUND: { status: 404, title: "Administration target not found" },
  ADMIN_STATE_CONFLICT: { status: 409, title: "Administration state changed" },
  ADMIN_LAST_ADMIN: { status: 409, title: "At least one active administrator is required" },
  ADMIN_IDEMPOTENCY_CONFLICT: { status: 409, title: "Idempotency conflict" },
  ADMIN_DEPENDENCY_UNAVAILABLE: { status: 503, title: "Administration service unavailable" },
  WEBDAV_SYNC_INPUT_INVALID: { status: 400, title: "Invalid request" },
  WEBDAV_SYNC_FORBIDDEN: { status: 403, title: "Forbidden" },
  WEBDAV_SYNC_NOT_FOUND: { status: 404, title: "WebDAV sync target not found" },
  WEBDAV_SYNC_STATE_CONFLICT: { status: 409, title: "WebDAV sync state changed" },
  WEBDAV_SYNC_IDEMPOTENCY_CONFLICT: { status: 409, title: "Idempotency conflict" },
  WEBDAV_SYNC_PATH_OVERLAP: { status: 409, title: "WebDAV directories overlap" },
  WEBDAV_SYNC_ENDPOINT_FORBIDDEN: { status: 422, title: "WebDAV endpoint is not allowed" },
  WEBDAV_SYNC_DEPENDENCY_UNAVAILABLE: { status: 503, title: "WebDAV sync service unavailable" },
  PRINT_ARCHIVE_INPUT_INVALID: { status: 400, title: "Invalid request" },
  PRINT_ARCHIVE_FORBIDDEN: { status: 403, title: "Forbidden" },
  PRINT_ARCHIVE_NOT_FOUND: { status: 404, title: "Approval not found" },
  PRINT_ARCHIVE_OBJECT_INVALID: { status: 409, title: "Printable PDF is not ready" },
  PRINT_ARCHIVE_IDEMPOTENCY_CONFLICT: { status: 409, title: "Idempotency conflict" },
  PRINT_ARCHIVE_DEPENDENCY_UNAVAILABLE: { status: 503, title: "Print archive service unavailable" },
  INVALID_STORAGE_OBJECT_MEDIA_TYPE: { status: 415, title: "Unsupported media type" },
  STORAGE_OBJECT_HEAD_MISMATCH: { status: 503, title: "Storage service unavailable" },
  STORAGE_UPLOAD_EXPIRED: { status: 409, title: "Upload expired" },
  STORAGE_UPLOAD_SUPERSEDED: { status: 409, title: "Upload superseded" },
  STORAGE_ACCESS_INPUT_INVALID: { status: 400, title: "Invalid request" },
  STORAGE_ACCESS_NOT_FOUND: { status: 404, title: "Object not found" },
  STORAGE_ACCESS_DEPENDENCY_UNAVAILABLE: { status: 503, title: "Storage service unavailable" },
  CLIENT_ADDRESS_INVALID: { status: 400, title: "Invalid client address" }
});

export function createErrorMiddleware(options: {
  readonly logger: SecurityLogger;
  readonly emergencySink: EmergencySink;
}): ErrorRequestHandler {
  if (!options?.logger || typeof options.logger !== "object" || typeof options.logger.error !== "function") {
    throw new Error("ERROR_MIDDLEWARE_LOGGER_REQUIRED");
  }
  if (typeof options.emergencySink !== "function") {
    throw new Error("ERROR_MIDDLEWARE_EMERGENCY_SINK_REQUIRED");
  }
  const logger = options.logger;
  const emergencySink = options.emergencySink;
  return (error, _request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    const requestId = safeRequestId(response.locals.requestId) ?? createRequestId();
    response.locals.requestId = requestId;
    response.setHeader("X-Request-ID", requestId);
    response.setHeader("Cache-Control", "no-store");
    const code = errorCode(error);
    const domain = code ? DOMAIN_PROBLEMS[code] : undefined;
    const database = classifyDatabaseError(error);
    const bodyParser = bodyParserProblem(error);
    let mapping: ProblemMapping & { code: string };
    if (error instanceof HttpProblem) {
      mapping = { status: error.status, title: error.title, code: error.code };
    } else if (bodyParser) {
      mapping = bodyParser;
    } else if (code && domain) {
      mapping = { ...domain, code };
    } else if (database.kind !== "unknown") {
      mapping = { status: 503, title: "Service unavailable", code: "DATABASE_UNAVAILABLE" };
    } else {
      mapping = { status: 500, title: "Internal server error", code: "INTERNAL_ERROR" };
    }

    if (mapping.status >= 500) {
      try {
        logger.error({ requestId, code: mapping.code });
      } catch {
        emergencySink({ requestId, code: "LOGGER_FAILURE" });
      }
    }
    sendProblem(response, { status: mapping.status, title: mapping.title, code: mapping.code, requestId });
  };
}

function bodyParserProblem(error: unknown): (ProblemMapping & { code: string }) | undefined {
  if (!error || typeof error !== "object") return undefined;
  const type = "type" in error ? (error as { type?: unknown }).type : undefined;
  const status = "status" in error ? (error as { status?: unknown }).status : undefined;
  if (type === "entity.parse.failed" && status === 400) {
    return { status: 400, title: "Invalid request body", code: "REQUEST_BODY_INVALID" };
  }
  if (type === "entity.too.large" && status === 413) {
    return { status: 413, title: "Request body too large", code: "REQUEST_BODY_TOO_LARGE" };
  }
  return undefined;
}

function errorCode(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
