import { Router } from "express";
import { updateOwnAccountRequestSchema } from "../../../../shared/contracts/identity.ts";
import { asyncRoute } from "../../../platform/http/asyncRoute.ts";
import { HttpProblem } from "../../../platform/http/problemResponse.ts";
import { createCsrfMiddleware, type CsrfProtection } from "../../../platform/security/csrf.ts";
import { createOriginGuard } from "../../../platform/security/originGuard.ts";
import { clearSessionCookie, createSessionMiddleware, readSessionCookie, requirePlatformAuth,
  type PlatformAuthLocals, type SessionCookieConfig } from "../../../platform/security/sessionMiddleware.ts";
import type { SessionAuthenticator } from "../../../platform/security/sessionMiddleware.ts";
import { parseBody, requestId } from "./authRoutes.ts";

type SessionRoutesService = SessionAuthenticator & {
  revokeCurrent(input: { sessionToken: string; requestId: string }): Promise<{ revoked: true }>;
};

type SessionAuthorizationService = {
  getSessionContext(input: { userId: string }): Promise<Record<string, unknown>>;
};

type AccountRoutesService = {
  updateOwnAccount(input: { userId: string; username: string; email: string; currentPassword: string;
    newPassword?: string; requestId: string }): Promise<Record<string, unknown>>;
};

export function createSessionRoutes(options: { readonly sessions: SessionRoutesService;
  readonly authorization: SessionAuthorizationService; readonly account: AccountRoutesService; readonly publicBaseUrl: string;
  readonly cookie: SessionCookieConfig; readonly csrf: CsrfProtection }) {
  const router = Router();
  const session = createSessionMiddleware({ cookieName: options.cookie.name, sessions: options.sessions });
  router.get("/", session, requirePlatformAuth, asyncRoute(async (_request, response) => {
    const auth = (response.locals as PlatformAuthLocals).platformAuth!;
    const context = await options.authorization.getSessionContext({ userId: auth.user.id });
    response.status(200).json({ ...context, csrfToken: options.csrf.issue(auth.session.id) });
  }));
  router.patch("/account", createOriginGuard({ publicBaseUrl: options.publicBaseUrl }), session, requirePlatformAuth,
    createCsrfMiddleware({ csrf: options.csrf }), asyncRoute(async (request, response) => {
      const auth = (response.locals as PlatformAuthLocals).platformAuth!;
      const result = await options.account.updateOwnAccount({ userId: auth.user.id,
        ...parseBody(updateOwnAccountRequestSchema, request.body), requestId: requestId(response.locals) });
      clearSessionCookie(response, options.cookie);
      response.status(200).json(result);
    }));
  router.delete("/", createOriginGuard({ publicBaseUrl: options.publicBaseUrl }), session, requirePlatformAuth,
    createCsrfMiddleware({ csrf: options.csrf }), asyncRoute(async (request, response) => {
      const token = readSessionCookie(request, options.cookie.name);
      if (!token) throw new HttpProblem(401, "SESSION_INVALID", "Authentication required");
      await options.sessions.revokeCurrent({ sessionToken: token, requestId: requestId(response.locals) });
      clearSessionCookie(response, options.cookie);
      response.status(204).end();
    }));
  return router;
}
