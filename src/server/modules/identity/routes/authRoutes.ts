import { Router } from "express";
import type { z } from "zod";
import { loginRequestSchema, mfaCompleteRequestSchema } from "../../../../shared/contracts/identity.ts";
import { asyncRoute } from "../../../platform/http/asyncRoute.ts";
import { HttpProblem } from "../../../platform/http/problemResponse.ts";
import { clientAddressPrefix } from "../../../platform/security/clientAddress.ts";
import { createOriginGuard } from "../../../platform/security/originGuard.ts";
import { setSessionCookie, type SessionCookieConfig } from "../../../platform/security/sessionMiddleware.ts";

type AuthenticationRoutesService = {
  login(input: { email: string; password: string; sourceIpPrefix: string; requestId: string;
    clientSummary?: string }): Promise<{ next: "mfa"; challengeToken: string }>;
  completeMfa(input: { challengeToken: string; factor: { method: "totp" | "recovery"; code: string };
    sourceIpPrefix: string; requestId: string; clientSummary?: string }): Promise<{
      sessionToken: string; user: Record<string, unknown>;
    }>;
};

export function createAuthRoutes(options: { readonly authentication: AuthenticationRoutesService;
  readonly publicBaseUrl: string; readonly cookie: SessionCookieConfig }) {
  const router = Router();
  const originGuard = createOriginGuard({ publicBaseUrl: options.publicBaseUrl });
  router.post("/login", originGuard, asyncRoute(async (request, response) => {
    const body = parseBody(loginRequestSchema, request.body);
    const result = await options.authentication.login({ ...body, sourceIpPrefix: clientAddressPrefix(request),
      requestId: requestId(response.locals), ...clientSummary(request.get("user-agent")) });
    response.status(202).json(result);
  }));
  router.post("/mfa/complete", originGuard, asyncRoute(async (request, response) => {
    const body = parseBody(mfaCompleteRequestSchema, request.body);
    const result = await options.authentication.completeMfa({ ...body,
      sourceIpPrefix: clientAddressPrefix(request), requestId: requestId(response.locals),
      ...clientSummary(request.get("user-agent")) });
    setSessionCookie(response, options.cookie, result.sessionToken);
    response.status(200).json({ user: result.user });
  }));
  return router;
}

export function parseBody<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpProblem(400, "REQUEST_BODY_INVALID", "Invalid request body");
  return parsed.data;
}

export function requestId(locals: Record<string, unknown>) {
  const value = locals.requestId;
  if (typeof value !== "string") throw new HttpProblem(500, "REQUEST_CONTEXT_MISSING", "Internal server error");
  return value;
}

function clientSummary(value: string | undefined) {
  if (!value) return {};
  const normalized = Buffer.from(value, "utf8").subarray(0, 200).toString("utf8").replace(/\uFFFD$/u, "").trim();
  return normalized && !/[\r\n\0]/.test(normalized) ? { clientSummary: normalized } : {};
}
