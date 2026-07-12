import { Router } from "express";
import { asyncRoute } from "../../../platform/http/asyncRoute.ts";
import { HttpProblem } from "../../../platform/http/problemResponse.ts";
import { createCsrfMiddleware, type CsrfProtection } from "../../../platform/security/csrf.ts";
import { createOriginGuard } from "../../../platform/security/originGuard.ts";
import { clearSessionCookie, createSessionMiddleware, readSessionCookie, requirePlatformAuth,
  type PlatformAuthLocals, type SessionCookieConfig } from "../../../platform/security/sessionMiddleware.ts";
import type { SessionAuthenticator } from "../../../platform/security/sessionMiddleware.ts";
import { requestId } from "./authRoutes.ts";

type SessionRoutesService = SessionAuthenticator & {
  revokeCurrent(input: { sessionToken: string; requestId: string }): Promise<{ revoked: true }>;
};

type SessionAuthorizationService = {
  getSessionContext(input: { userId: string }): Promise<Record<string, unknown>>;
};

export function createSessionRoutes(options: { readonly sessions: SessionRoutesService;
  readonly authorization: SessionAuthorizationService; readonly publicBaseUrl: string;
  readonly cookie: SessionCookieConfig; readonly csrf: CsrfProtection }) {
  const router = Router();
  const session = createSessionMiddleware({ cookieName: options.cookie.name, sessions: options.sessions });
  router.get("/", session, requirePlatformAuth, asyncRoute(async (_request, response) => {
    const auth = (response.locals as PlatformAuthLocals).platformAuth!;
    const context = await options.authorization.getSessionContext({ userId: auth.user.id });
    response.status(200).json({ ...context, csrfToken: options.csrf.issue(auth.session.id) });
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
