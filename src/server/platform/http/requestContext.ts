import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type RequestContextLocals = { requestId: string };

export function requestContext(): RequestHandler {
  return (request, response, next) => {
    const incoming = request.get("x-request-id");
    const requestId = incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();
    response.locals.requestId = requestId;
    response.setHeader("X-Request-ID", requestId);
    next();
  };
}
