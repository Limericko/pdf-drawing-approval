import { Router } from "express";
import { completeInvitationRequestSchema, createInvitationRequestSchema,
  prepareInvitationRequestSchema } from "../../../../shared/contracts/identity.ts";
import { asyncRoute } from "../../../platform/http/asyncRoute.ts";
import { clientAddressPrefix } from "../../../platform/security/clientAddress.ts";
import { createCsrfMiddleware, type CsrfProtection } from "../../../platform/security/csrf.ts";
import { createOriginGuard } from "../../../platform/security/originGuard.ts";
import { createSessionMiddleware, requirePlatformAuth, type PlatformAuthLocals,
  type SessionCookieConfig } from "../../../platform/security/sessionMiddleware.ts";
import { parseBody } from "./authRoutes.ts";

type InvitationRoutesService = {
  createInvitation(input: { email: string; platformRole: "admin" | "member"; projectId: string;
    projectRole: "manager" | "designer" | "supervisor" | "process" | "viewer";
    invitedByUserId: string }): Promise<{ invitationId: string }>;
  prepare(input: { invitationToken: string; sourceIpPrefix: string }): Promise<{
    enrollmentToken: string; otpauthUri: string;
  }>;
  complete(input: { enrollmentToken: string; sourceIpPrefix: string; password: string; totp: string }): Promise<{
    recoveryCodes: readonly string[];
  }>;
};

export function createInvitationRoutes(options: { readonly invitations: InvitationRoutesService;
  readonly sessions: Parameters<typeof createSessionMiddleware>[0]["sessions"];
  readonly publicBaseUrl: string; readonly cookie: SessionCookieConfig; readonly csrf: CsrfProtection }) {
  const router = Router();
  const origin = createOriginGuard({ publicBaseUrl: options.publicBaseUrl });
  const session = createSessionMiddleware({ cookieName: options.cookie.name, sessions: options.sessions });
  router.post("/", origin, session, requirePlatformAuth, createCsrfMiddleware({ csrf: options.csrf }),
    asyncRoute(async (request, response) => {
      const body = parseBody(createInvitationRequestSchema, request.body);
      const actor = (response.locals as PlatformAuthLocals).platformAuth!.user;
      const result = await options.invitations.createInvitation({ ...body, invitedByUserId: actor.id });
      response.status(201).json(result);
    }));
  router.post("/prepare", origin, asyncRoute(async (request, response) => {
    const body = parseBody(prepareInvitationRequestSchema, request.body);
    const result = await options.invitations.prepare({ ...body, sourceIpPrefix: clientAddressPrefix(request) });
    response.status(200).json(result);
  }));
  router.post("/complete", origin, asyncRoute(async (request, response) => {
    const body = parseBody(completeInvitationRequestSchema, request.body);
    const result = await options.invitations.complete({ ...body, sourceIpPrefix: clientAddressPrefix(request) });
    response.status(200).json(result);
  }));
  return router;
}
