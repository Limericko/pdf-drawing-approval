import type { ErrorRequestHandler } from "express";
import { classifyDatabaseError } from "../database/databaseErrors.ts";
import { HttpProblem, sendProblem } from "./problemResponse.ts";
import { createRequestId, safeRequestId } from "./requestContext.ts";

type SecurityLogger = {
  error(event: { readonly requestId: string; readonly userId?: string; readonly code: string }): void;
};

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
  CLIENT_ADDRESS_INVALID: { status: 400, title: "Invalid client address" }
});

export function createErrorMiddleware(options: { readonly logger: SecurityLogger }): ErrorRequestHandler {
  if (!options?.logger) throw new Error("ERROR_MIDDLEWARE_LOGGER_REQUIRED");
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
        options.logger.error({ requestId, code: mapping.code });
      } catch {
        // The HTTP response must remain stable even if the emergency logger is unavailable.
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
