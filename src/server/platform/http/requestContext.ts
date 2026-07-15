import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import { requestIdSchema } from "../../../shared/contracts/problem.ts";

export type RequestContextLocals = { requestId: string };

export function requestContext(): RequestHandler {
  return (request, response, next) => {
    const incoming = request.get("x-request-id");
    const requestId = safeRequestId(incoming) ?? createRequestId();
    response.locals.requestId = requestId;
    response.setHeader("X-Request-ID", requestId);
    next();
  };
}

export function safeRequestId(value: unknown) {
  return requestIdSchema.safeParse(value).success ? value as string : undefined;
}

export function createRequestId() {
  return randomUUID();
}
