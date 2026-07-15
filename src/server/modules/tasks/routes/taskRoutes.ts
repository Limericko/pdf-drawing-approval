import { Router } from "express";
import { taskListQuerySchema } from "../../../../shared/contracts/business.ts";
import { asyncRoute } from "../../../platform/http/asyncRoute.ts";
import { HttpProblem } from "../../../platform/http/problemResponse.ts";
import { createSessionMiddleware, requirePlatformAuth, type PlatformAuthLocals,
  type SessionCookieConfig } from "../../../platform/security/sessionMiddleware.ts";
import type { createTaskService } from "../taskService.ts";
import { noStoreBusinessResponses } from "../../approvals/routes/approvalRoutes.ts";

export function createTaskRoutes(options: {
  readonly tasks: ReturnType<typeof createTaskService>;
  readonly sessions: Parameters<typeof createSessionMiddleware>[0]["sessions"];
  readonly cookie: SessionCookieConfig;
}) {
  if (!options?.tasks) throw new Error("TASK_ROUTES_SERVICE_REQUIRED");
  const router = Router();
  const session = createSessionMiddleware({ cookieName: options.cookie.name, sessions: options.sessions });
  router.use(noStoreBusinessResponses);
  router.get("/", session, requirePlatformAuth, asyncRoute(async (request, response) => {
    const query = taskListQuerySchema.safeParse(request.query);
    if (!query.success) throw new HttpProblem(400, "TASK_INPUT_INVALID", "Invalid request");
    const actor = (response.locals as PlatformAuthLocals).platformAuth!.user;
    response.status(200).json(await options.tasks.listMyTasks({
      actorUserId: actor.id,
      ...(query.data.projectId ? { projectId: query.data.projectId } : {})
    }));
  }));
  return router;
}
