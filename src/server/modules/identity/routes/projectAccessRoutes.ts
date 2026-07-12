import { Router } from "express";
import { createProjectRequestSchema, projectIdParamsSchema } from "../../../../shared/contracts/identity.ts";
import { asyncRoute } from "../../../platform/http/asyncRoute.ts";
import { HttpProblem } from "../../../platform/http/problemResponse.ts";
import { createCsrfMiddleware, type CsrfProtection } from "../../../platform/security/csrf.ts";
import { createOriginGuard } from "../../../platform/security/originGuard.ts";
import { createSessionMiddleware, requirePlatformAuth, type PlatformAuthLocals,
  type SessionCookieConfig } from "../../../platform/security/sessionMiddleware.ts";
import { parseBody, requestId } from "./authRoutes.ts";

type ProjectAuthorizationService = {
  listProjects(input: { userId: string }): Promise<{ projects: readonly unknown[] }>;
  getProjectAccess(input: { projectId: string; userId: string }): Promise<Record<string, unknown>>;
  createProject(input: { name: string; actorUserId: string; requestId: string }): Promise<Record<string, unknown>>;
};

export function createProjectAccessRoutes(options: { readonly authorization: ProjectAuthorizationService;
  readonly sessions: Parameters<typeof createSessionMiddleware>[0]["sessions"];
  readonly publicBaseUrl: string; readonly cookie: SessionCookieConfig; readonly csrf: CsrfProtection }) {
  const router = Router();
  const session = createSessionMiddleware({ cookieName: options.cookie.name, sessions: options.sessions });
  router.post("/", createOriginGuard({ publicBaseUrl: options.publicBaseUrl }), session, requirePlatformAuth,
    createCsrfMiddleware({ csrf: options.csrf }), asyncRoute(async (request, response) => {
      const body = parseBody(createProjectRequestSchema, request.body);
      const actor = (response.locals as PlatformAuthLocals).platformAuth!.user;
      const result = await options.authorization.createProject({ ...body, actorUserId: actor.id,
        requestId: requestId(response.locals) });
      response.status(201).json(result);
    }));
  router.get("/", session, requirePlatformAuth, asyncRoute(async (_request, response) => {
    const actor = (response.locals as PlatformAuthLocals).platformAuth!.user;
    response.status(200).json(await options.authorization.listProjects({ userId: actor.id }));
  }));
  router.get("/:projectId/access", session, requirePlatformAuth, asyncRoute(async (request, response) => {
    const parsed = projectIdParamsSchema.safeParse(request.params);
    if (!parsed.success) throw new HttpProblem(400, "AUTHORIZATION_INPUT_INVALID", "Invalid request");
    const actor = (response.locals as PlatformAuthLocals).platformAuth!.user;
    response.status(200).json(await options.authorization.getProjectAccess({ projectId: parsed.data.projectId,
      userId: actor.id }));
  }));
  return router;
}
