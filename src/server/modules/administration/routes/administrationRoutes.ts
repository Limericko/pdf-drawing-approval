import { Router } from "express";
import { z } from "zod";
import { adminAuditQuerySchema, adminUserListQuerySchema, retryAdminJobRequestSchema,
  revokeAdminSessionsRequestSchema, setAdminUserStatusRequestSchema,
  updateAdminMembershipRequestSchema } from "../../../../shared/contracts/administration.ts";
import { uuidV7Schema } from "../../../../shared/contracts/common.ts";
import { asyncRoute } from "../../../platform/http/asyncRoute.ts";
import { HttpProblem } from "../../../platform/http/problemResponse.ts";
import { createCsrfMiddleware, type CsrfProtection } from "../../../platform/security/csrf.ts";
import { createOriginGuard } from "../../../platform/security/originGuard.ts";
import { createSessionMiddleware, requirePlatformAuth, type PlatformAuthLocals,
  type SessionCookieConfig } from "../../../platform/security/sessionMiddleware.ts";
import { noStoreBusinessResponses } from "../../approvals/routes/approvalRoutes.ts";
import { parseBody, requestId } from "../../identity/routes/authRoutes.ts";
import type { createAdministrationService } from "../administrationService.ts";

const userParams = z.object({ userId: uuidV7Schema }).strict();
const jobParams = z.object({ jobId: uuidV7Schema }).strict();
const membershipParams = z.object({ projectId: uuidV7Schema, membershipId: uuidV7Schema }).strict();

export function createAdministrationRoutes(options: {
  readonly administration: ReturnType<typeof createAdministrationService>;
  readonly sessions: Parameters<typeof createSessionMiddleware>[0]["sessions"];
  readonly publicBaseUrl: string;
  readonly cookie: SessionCookieConfig;
  readonly csrf: CsrfProtection;
}) {
  if (!options?.administration) throw new Error("ADMIN_ROUTES_SERVICE_REQUIRED");
  const router = Router();
  const session = createSessionMiddleware({ cookieName: options.cookie.name, sessions: options.sessions });
  const auth = [session, requirePlatformAuth] as const;
  const mutate = [createOriginGuard({ publicBaseUrl: options.publicBaseUrl }), session, requirePlatformAuth,
    createCsrfMiddleware({ csrf: options.csrf })] as const;
  router.use(noStoreBusinessResponses);
  router.get("/users", ...auth, asyncRoute(async (request, response) => {
    const query = adminUserListQuerySchema.safeParse(request.query);
    if (!query.success) throw invalid();
    response.status(200).json(await options.administration.listUsers({ actorUserId: actor(response.locals),
      ...query.data }));
  }));
  router.patch("/users/:userId/status", ...mutate, asyncRoute(async (request, response) => {
    const params = parse(userParams, request.params);
    response.status(200).json(await options.administration.setUserStatus({ actorUserId: actor(response.locals),
      targetUserId: params.userId, requestId: requestId(response.locals),
      update: parseBody(setAdminUserStatusRequestSchema, request.body) }));
  }));
  router.post("/users/:userId/sessions/revoke", ...mutate, asyncRoute(async (request, response) => {
    const params = parse(userParams, request.params);
    response.status(200).json(await options.administration.revokeUserSessions({ actorUserId: actor(response.locals),
      targetUserId: params.userId, requestId: requestId(response.locals),
      update: parseBody(revokeAdminSessionsRequestSchema, request.body) }));
  }));
  router.patch("/projects/:projectId/memberships/:membershipId", ...mutate,
    asyncRoute(async (request, response) => {
      const params = parse(membershipParams, request.params);
      response.status(200).json(await options.administration.updateMembership({ actorUserId: actor(response.locals),
        ...params, requestId: requestId(response.locals),
        update: parseBody(updateAdminMembershipRequestSchema, request.body) }));
    }));
  router.post("/jobs/:jobId/retry", ...mutate, asyncRoute(async (request, response) => {
    const params = parse(jobParams, request.params);
    response.status(200).json(await options.administration.retryDeadJob({ actorUserId: actor(response.locals),
      jobId: params.jobId, requestId: requestId(response.locals),
      update: parseBody(retryAdminJobRequestSchema, request.body) }));
  }));
  router.get("/diagnostics", ...auth, asyncRoute(async (_request, response) => {
    response.status(200).json(await options.administration.getDiagnostics({ actorUserId: actor(response.locals) }));
  }));
  router.get("/backups", ...auth, asyncRoute(async (_request, response) => {
    response.status(200).json(await options.administration.listBackups({ actorUserId: actor(response.locals) }));
  }));
  router.get("/audit", ...auth, asyncRoute(async (request, response) => {
    const query = adminAuditQuerySchema.safeParse(request.query);
    if (!query.success) throw invalid();
    response.status(200).json(await options.administration.listAudit({ actorUserId: actor(response.locals),
      page: query.data.page, pageSize: query.data.pageSize,
      ...(query.data.actorUserId ? { filterActorUserId: query.data.actorUserId } : {}),
      ...(query.data.projectId ? { projectId: query.data.projectId } : {}),
      ...(query.data.action ? { action: query.data.action } : {}), ...(query.data.from ? { from: query.data.from } : {}),
      ...(query.data.to ? { to: query.data.to } : {}) }));
  }));
  return router;
}

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalid();
  return parsed.data;
}
function actor(locals: Record<string, unknown>) { return (locals as PlatformAuthLocals).platformAuth!.user.id; }
function invalid() { return new HttpProblem(400, "ADMIN_INPUT_INVALID", "Invalid request"); }
