import { Router } from "express";
import { z } from "zod";
import {
  pdmPartListQuerySchema,
  retryPdmPublishRequestSchema,
  updatePdmMetadataRequestSchema,
  voidPdmRevisionRequestSchema
} from "../../../../shared/contracts/business.ts";
import { uuidV7Schema } from "../../../../shared/contracts/common.ts";
import { asyncRoute } from "../../../platform/http/asyncRoute.ts";
import { HttpProblem } from "../../../platform/http/problemResponse.ts";
import { createCsrfMiddleware, type CsrfProtection } from "../../../platform/security/csrf.ts";
import { createOriginGuard } from "../../../platform/security/originGuard.ts";
import {
  createSessionMiddleware,
  requirePlatformAuth,
  type PlatformAuthLocals,
  type SessionCookieConfig
} from "../../../platform/security/sessionMiddleware.ts";
import { noStoreBusinessResponses } from "../../approvals/routes/approvalRoutes.ts";
import { parseBody, requestId } from "../../identity/routes/authRoutes.ts";
import type { createPdmService } from "../pdmService.ts";

const partParamsSchema = z.object({ projectId: uuidV7Schema, partId: uuidV7Schema }).strict();
const linkParamsSchema = z.object({ projectId: uuidV7Schema, linkId: uuidV7Schema }).strict();

export function createPdmRoutes(options: {
  readonly pdm: ReturnType<typeof createPdmService>;
  readonly sessions: Parameters<typeof createSessionMiddleware>[0]["sessions"];
  readonly publicBaseUrl: string;
  readonly cookie: SessionCookieConfig;
  readonly csrf: CsrfProtection;
}) {
  if (!options?.pdm) throw new Error("PDM_ROUTES_SERVICE_REQUIRED");
  const router = Router();
  const session = createSessionMiddleware({ cookieName: options.cookie.name, sessions: options.sessions });
  const authenticated = [session, requirePlatformAuth] as const;
  const mutating = [
    createOriginGuard({ publicBaseUrl: options.publicBaseUrl }),
    session,
    requirePlatformAuth,
    createCsrfMiddleware({ csrf: options.csrf })
  ] as const;

  router.use(noStoreBusinessResponses);
  router.get("/:projectId/pdm/parts", ...authenticated, asyncRoute(async (request, response) => {
    const projectId = parseParams(z.object({ projectId: uuidV7Schema }).strict(), request.params).projectId;
    const query = pdmPartListQuerySchema.safeParse(request.query);
    if (!query.success) throw invalid();
    response.status(200).json(await options.pdm.listParts({
      projectId,
      actorUserId: actorId(response.locals),
      page: query.data.page,
      pageSize: query.data.pageSize,
      ...(query.data.keyword ? { keyword: query.data.keyword } : {}),
      ...(query.data.releaseStatus ? { releaseStatus: query.data.releaseStatus } : {}),
      sort: query.data.sort
    }));
  }));

  router.get("/:projectId/pdm/parts/:partId", ...authenticated, asyncRoute(async (request, response) => {
    const params = parseParams(partParamsSchema, request.params);
    response.status(200).json(await options.pdm.getPart({
      projectId: params.projectId,
      partId: params.partId,
      actorUserId: actorId(response.locals)
    }));
  }));

  router.patch("/:projectId/pdm/revisions/:linkId/metadata", ...mutating,
    asyncRoute(async (request, response) => {
      const params = parseParams(linkParamsSchema, request.params);
      response.status(200).json(await options.pdm.updateMetadata({
        projectId: params.projectId,
        linkId: params.linkId,
        actorUserId: actorId(response.locals),
        requestId: requestId(response.locals),
        update: parseBody(updatePdmMetadataRequestSchema, request.body)
      }));
    }));

  router.post("/:projectId/pdm/revisions/:linkId/retry", ...mutating,
    asyncRoute(async (request, response) => {
      const params = parseParams(linkParamsSchema, request.params);
      response.status(200).json(await options.pdm.retryPublish({
        projectId: params.projectId,
        linkId: params.linkId,
        actorUserId: actorId(response.locals),
        requestId: requestId(response.locals),
        retry: parseBody(retryPdmPublishRequestSchema, request.body)
      }));
    }));

  router.post("/:projectId/pdm/revisions/:linkId/void", ...mutating,
    asyncRoute(async (request, response) => {
      const params = parseParams(linkParamsSchema, request.params);
      response.status(200).json(await options.pdm.voidRevision({
        projectId: params.projectId,
        linkId: params.linkId,
        actorUserId: actorId(response.locals),
        requestId: requestId(response.locals),
        update: parseBody(voidPdmRevisionRequestSchema, request.body)
      }));
    }));
  return router;
}

function parseParams<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalid();
  return parsed.data;
}

function actorId(locals: Record<string, unknown>) {
  const auth = (locals as PlatformAuthLocals).platformAuth;
  if (!auth) throw new HttpProblem(401, "AUTHENTICATION_REQUIRED", "Authentication required");
  return auth.user.id;
}

function invalid() {
  return new HttpProblem(400, "PDM_INPUT_INVALID", "Invalid request");
}
