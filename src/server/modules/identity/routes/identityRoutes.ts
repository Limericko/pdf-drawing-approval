import { Router, type RequestHandler } from "express";
import type { PlatformEnvironment, VersionedKeyring } from "../../../platform/config/types.ts";
import { createCsrfProtection } from "../../../platform/security/csrf.ts";
import { resolveSessionCookieConfig } from "../../../platform/security/sessionMiddleware.ts";
import { createAuthRoutes } from "./authRoutes.ts";
import { createInvitationRoutes } from "./invitationRoutes.ts";
import { createProjectAccessRoutes } from "./projectAccessRoutes.ts";
import { createSessionRoutes } from "./sessionRoutes.ts";

export function createIdentityRoutes(options: {
  readonly config: { readonly publicBaseUrl: string; readonly environment: PlatformEnvironment;
    readonly cookieName: string; readonly cookieSecure: boolean };
  readonly csrfKeyring: VersionedKeyring;
  readonly services: {
    readonly authentication: Parameters<typeof createAuthRoutes>[0]["authentication"];
    readonly sessions: Parameters<typeof createSessionRoutes>[0]["sessions"];
    readonly account?: Parameters<typeof createSessionRoutes>[0]["account"];
    readonly invitations: Parameters<typeof createInvitationRoutes>[0]["invitations"];
    readonly authorization: Parameters<typeof createProjectAccessRoutes>[0]["authorization"] &
      Parameters<typeof createSessionRoutes>[0]["authorization"];
  };
  readonly logger: { error(event: { requestId: string; userId?: string; code: string }): void };
}) {
  if (!options?.logger) throw new Error("IDENTITY_ROUTE_LOGGER_REQUIRED");
  const router = Router();
  const cookie = resolveSessionCookieConfig(options.config);
  const csrf = createCsrfProtection({ keyring: options.csrfKeyring });
  router.use(noStoreIdentityResponses);
  router.use("/auth", createAuthRoutes({ authentication: options.services.authentication,
    publicBaseUrl: options.config.publicBaseUrl, cookie }));
  router.use("/session", createSessionRoutes({ sessions: options.services.sessions,
    authorization: options.services.authorization, account: options.services.account ?? {
      updateOwnAccount: async () => { throw new Error("ACCOUNT_SERVICE_UNAVAILABLE"); }
    },
    publicBaseUrl: options.config.publicBaseUrl, cookie, csrf }));
  router.use("/invitations", createInvitationRoutes({ invitations: options.services.invitations,
    sessions: options.services.sessions, publicBaseUrl: options.config.publicBaseUrl, cookie, csrf }));
  router.use("/projects", createProjectAccessRoutes({ authorization: options.services.authorization,
    sessions: options.services.sessions, publicBaseUrl: options.config.publicBaseUrl, cookie, csrf }));
  return router;
}

export const noStoreIdentityResponses: RequestHandler = (_request, response, next) => {
  response.setHeader("Cache-Control", "no-store");
  next();
};
