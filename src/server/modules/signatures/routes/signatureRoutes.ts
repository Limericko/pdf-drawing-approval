import { Router } from "express";
import { setSignatureAssetRequestSchema } from "../../../../shared/contracts/business.ts";
import { asyncRoute } from "../../../platform/http/asyncRoute.ts";
import { createCsrfMiddleware, type CsrfProtection } from "../../../platform/security/csrf.ts";
import { createOriginGuard } from "../../../platform/security/originGuard.ts";
import { createSessionMiddleware, requirePlatformAuth, type PlatformAuthLocals,
  type SessionCookieConfig } from "../../../platform/security/sessionMiddleware.ts";
import { noStoreBusinessResponses } from "../../approvals/routes/approvalRoutes.ts";
import { parseBody, requestId } from "../../identity/routes/authRoutes.ts";
import type { createSignatureService } from "../signatureService.ts";

export function createSignatureRoutes(options: {
  readonly signatures: ReturnType<typeof createSignatureService>;
  readonly sessions: Parameters<typeof createSessionMiddleware>[0]["sessions"];
  readonly publicBaseUrl: string;
  readonly cookie: SessionCookieConfig;
  readonly csrf: CsrfProtection;
}) {
  if (!options?.signatures) throw new Error("SIGNATURE_ROUTES_SERVICE_REQUIRED");
  const router = Router();
  const session = createSessionMiddleware({ cookieName: options.cookie.name, sessions: options.sessions });
  router.use(noStoreBusinessResponses);
  router.get("/", session, requirePlatformAuth, asyncRoute(async (_request, response) => {
    response.status(200).json(await options.signatures.getActive({ actorUserId: actor(response.locals) }));
  }));
  router.put("/", createOriginGuard({ publicBaseUrl: options.publicBaseUrl }), session, requirePlatformAuth,
    createCsrfMiddleware({ csrf: options.csrf }), asyncRoute(async (request, response) => {
      response.status(200).json(await options.signatures.setActive({ actorUserId: actor(response.locals),
        requestId: requestId(response.locals), update: parseBody(setSignatureAssetRequestSchema, request.body) }));
    }));
  return router;
}

function actor(locals: Record<string, unknown>) {
  return (locals as PlatformAuthLocals).platformAuth!.user.id;
}
