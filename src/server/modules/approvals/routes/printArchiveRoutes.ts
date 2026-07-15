import { Router } from "express";
import { z } from "zod";
import { recordPrintArchiveRequestSchema } from "../../../../shared/contracts/business.ts";
import { uuidV7Schema } from "../../../../shared/contracts/common.ts";
import { asyncRoute } from "../../../platform/http/asyncRoute.ts";
import { HttpProblem } from "../../../platform/http/problemResponse.ts";
import { createCsrfMiddleware, type CsrfProtection } from "../../../platform/security/csrf.ts";
import { createOriginGuard } from "../../../platform/security/originGuard.ts";
import { createSessionMiddleware, requirePlatformAuth, type PlatformAuthLocals,
  type SessionCookieConfig } from "../../../platform/security/sessionMiddleware.ts";
import { parseBody, requestId } from "../../identity/routes/authRoutes.ts";
import type { createPrintArchiveService } from "../printArchiveService.ts";
import { noStoreBusinessResponses } from "./approvalRoutes.ts";

const paramsSchema = z.object({ projectId: uuidV7Schema, approvalId: uuidV7Schema }).strict();

export function createPrintArchiveRoutes(options: {
  readonly printArchive: ReturnType<typeof createPrintArchiveService>;
  readonly sessions: Parameters<typeof createSessionMiddleware>[0]["sessions"];
  readonly publicBaseUrl: string;
  readonly cookie: SessionCookieConfig;
  readonly csrf: CsrfProtection;
}) {
  if (!options?.printArchive) throw new Error("PRINT_ARCHIVE_ROUTES_SERVICE_REQUIRED");
  const router = Router();
  const session = createSessionMiddleware({ cookieName: options.cookie.name, sessions: options.sessions });
  router.use(noStoreBusinessResponses);
  router.post("/:projectId/approvals/:approvalId/print-archive",
    createOriginGuard({ publicBaseUrl: options.publicBaseUrl }), session, requirePlatformAuth,
    createCsrfMiddleware({ csrf: options.csrf }), asyncRoute(async (request, response) => {
      const params = parseParams(request.params);
      response.status(201).json(await options.printArchive.record({ ...params,
        actorUserId: actor(response.locals), requestId: requestId(response.locals),
        result: parseBody(recordPrintArchiveRequestSchema, request.body) }));
    }));
  router.get("/:projectId/approvals/:approvalId/print-archive", session, requirePlatformAuth,
    asyncRoute(async (request, response) => {
      const params = parseParams(request.params);
      response.status(200).json(await options.printArchive.list({ ...params, actorUserId: actor(response.locals) }));
    }));
  return router;
}
function parseParams(value: unknown) { const parsed = paramsSchema.safeParse(value); if (!parsed.success)
  throw new HttpProblem(400, "PRINT_ARCHIVE_INPUT_INVALID", "Invalid request"); return parsed.data; }
function actor(locals: Record<string, unknown>) { return (locals as PlatformAuthLocals).platformAuth!.user.id; }
