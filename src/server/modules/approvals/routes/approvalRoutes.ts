import { Router, type RequestHandler } from "express";
import { z } from "zod";
import {
  approvalListQuerySchema,
  createDocumentDraftRequestSchema,
  reviewDecisionRequestSchema,
  reviewerRoleSchema,
  submitRevisionRequestSchema
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
import { parseBody, requestId } from "../../identity/routes/authRoutes.ts";
import type { createApprovalService } from "../approvalService.ts";

type ApprovalRoutesService = ReturnType<typeof createApprovalService>;

const revisionParamsSchema = z.object({ projectId: uuidV7Schema, revisionId: uuidV7Schema }).strict();
const approvalParamsSchema = z.object({ projectId: uuidV7Schema, approvalId: uuidV7Schema }).strict();
const decisionParamsSchema = approvalParamsSchema.extend({ reviewerRole: reviewerRoleSchema }).strict();

export function createApprovalRoutes(options: {
  readonly approvals: ApprovalRoutesService;
  readonly sessions: Parameters<typeof createSessionMiddleware>[0]["sessions"];
  readonly publicBaseUrl: string;
  readonly cookie: SessionCookieConfig;
  readonly csrf: CsrfProtection;
}) {
  if (!options?.approvals) throw new Error("APPROVAL_ROUTES_SERVICE_REQUIRED");
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
  router.post("/:projectId/documents/drafts", ...mutating, asyncRoute(async (request, response) => {
    const projectId = parseParams(z.object({ projectId: uuidV7Schema }).strict(), request.params).projectId;
    const actor = auth(response.locals).user;
    const result = await options.approvals.createDraft({
      projectId,
      actorUserId: actor.id,
      requestId: requestId(response.locals),
      draft: parseBody(createDocumentDraftRequestSchema, request.body)
    });
    response.status(201).json(result);
  }));

  router.post("/:projectId/revisions/:revisionId/submit", ...mutating, asyncRoute(async (request, response) => {
    const params = parseParams(revisionParamsSchema, request.params);
    const actor = auth(response.locals).user;
    const result = await options.approvals.submitRevision({
      projectId: params.projectId,
      revisionId: params.revisionId,
      actorUserId: actor.id,
      requestId: requestId(response.locals),
      submission: parseBody(submitRevisionRequestSchema, request.body)
    });
    response.status(201).json(result);
  }));

  router.post("/:projectId/approvals/:approvalId/decisions/:reviewerRole", ...mutating,
    asyncRoute(async (request, response) => {
      const params = parseParams(decisionParamsSchema, request.params);
      const actor = auth(response.locals).user;
      const result = await options.approvals.decide({
        projectId: params.projectId,
        approvalId: params.approvalId,
        reviewerRole: params.reviewerRole,
        actorUserId: actor.id,
        requestId: requestId(response.locals),
        decision: parseBody(reviewDecisionRequestSchema, request.body)
      });
      response.status(200).json(result);
    }));

  router.get("/:projectId/approvals", ...authenticated, asyncRoute(async (request, response) => {
    const projectId = parseParams(z.object({ projectId: uuidV7Schema }).strict(), request.params).projectId;
    const query = approvalListQuerySchema.safeParse(request.query);
    if (!query.success) throw new HttpProblem(400, "APPROVAL_INPUT_INVALID", "Invalid request");
    const actor = auth(response.locals).user;
    response.status(200).json(await options.approvals.listApprovals({
      projectId,
      actorUserId: actor.id,
      page: query.data.page,
      pageSize: query.data.pageSize
    }));
  }));

  router.get("/:projectId/approvals/:approvalId", ...authenticated, asyncRoute(async (request, response) => {
    const params = parseParams(approvalParamsSchema, request.params);
    const actor = auth(response.locals).user;
    response.status(200).json(await options.approvals.getApproval({
      projectId: params.projectId,
      approvalId: params.approvalId,
      actorUserId: actor.id
    }));
  }));
  return router;
}

export const noStoreBusinessResponses: RequestHandler = (_request, response, next) => {
  response.setHeader("Cache-Control", "no-store");
  next();
};

function parseParams<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpProblem(400, "APPROVAL_INPUT_INVALID", "Invalid request");
  return parsed.data;
}

function auth(locals: Record<string, unknown>) {
  const value = (locals as PlatformAuthLocals).platformAuth;
  if (!value) throw new HttpProblem(401, "AUTHENTICATION_REQUIRED", "Authentication required");
  return value;
}
