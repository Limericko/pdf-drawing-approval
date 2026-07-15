import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { createIssueRequestSchema, forceCloseIssueRequestSchema, issueListQuerySchema,
  reviewIssueRequestSchema, startIssueRequestSchema, submitIssueRequestSchema } from "../../../../shared/contracts/business.ts";
import { uuidV7Schema } from "../../../../shared/contracts/common.ts";
import { asyncRoute } from "../../../platform/http/asyncRoute.ts";
import { HttpProblem } from "../../../platform/http/problemResponse.ts";
import { createCsrfMiddleware, type CsrfProtection } from "../../../platform/security/csrf.ts";
import { createOriginGuard } from "../../../platform/security/originGuard.ts";
import { createSessionMiddleware, requirePlatformAuth, type PlatformAuthLocals,
  type SessionCookieConfig } from "../../../platform/security/sessionMiddleware.ts";
import { noStoreBusinessResponses } from "../../approvals/routes/approvalRoutes.ts";
import { parseBody, requestId } from "../../identity/routes/authRoutes.ts";
import type { createIssueService } from "../issueService.ts";

const projectSchema = z.object({ projectId: uuidV7Schema }).strict();
const approvalSchema = projectSchema.extend({ approvalId: uuidV7Schema }).strict();
const issueSchema = projectSchema.extend({ issueId: uuidV7Schema }).strict();

export function createIssueRoutes(options: {
  readonly issues: ReturnType<typeof createIssueService>;
  readonly sessions: Parameters<typeof createSessionMiddleware>[0]["sessions"];
  readonly publicBaseUrl: string;
  readonly cookie: SessionCookieConfig;
  readonly csrf: CsrfProtection;
}) {
  if (!options?.issues) throw new Error("ISSUE_ROUTES_SERVICE_REQUIRED");
  const router = Router();
  const session = createSessionMiddleware({ cookieName: options.cookie.name, sessions: options.sessions });
  const auth = [session, requirePlatformAuth] as const;
  const mutate = [createOriginGuard({ publicBaseUrl: options.publicBaseUrl }), session, requirePlatformAuth,
    createCsrfMiddleware({ csrf: options.csrf })] as const;
  router.use(noStoreBusinessResponses);
  router.post("/:projectId/approvals/:approvalId/issues", ...mutate, asyncRoute(async (request, response) => {
    const params = parse(approvalSchema, request.params);
    response.status(201).json(await options.issues.createIssue({ projectId: params.projectId,
      approvalId: params.approvalId, actorUserId: actor(response.locals), requestId: requestId(response.locals),
      issue: parseBody(createIssueRequestSchema, request.body) }));
  }));
  router.get("/:projectId/issues", ...auth, asyncRoute(async (request, response) => {
    const projectId = parse(projectSchema, request.params).projectId;
    const query = issueListQuerySchema.safeParse(request.query);
    if (!query.success) throw invalid();
    response.status(200).json(await options.issues.listIssues({ projectId, actorUserId: actor(response.locals),
      ...query.data }));
  }));
  router.get("/:projectId/issues/:issueId", ...auth, asyncRoute(async (request, response) => {
    const params = parse(issueSchema, request.params);
    response.status(200).json(await options.issues.getIssue({ ...params, actorUserId: actor(response.locals) }));
  }));
  command(router, "start", startIssueRequestSchema, (service, input) => service.startIssue(input), options, issueSchema, mutate);
  command(router, "submit", submitIssueRequestSchema, (service, input) => service.submitIssue(input), options, issueSchema, mutate);
  command(router, "review", reviewIssueRequestSchema, (service, input) => service.reviewIssue(input), options, issueSchema, mutate);
  command(router, "force-close", forceCloseIssueRequestSchema, (service, input) => service.forceCloseIssue(input), options,
    issueSchema, mutate);
  return router;
}

function command(router: Router, action: string, bodySchema: z.ZodTypeAny,
  run: (service: ReturnType<typeof createIssueService>, input: never) => Promise<unknown>,
  options: Parameters<typeof createIssueRoutes>[0], paramsSchema: typeof issueSchema,
  middleware: readonly RequestHandler[]) {
  router.post(`/:projectId/issues/:issueId/${action}`, ...middleware, asyncRoute(async (request, response) => {
    const params = parse(paramsSchema, request.params);
    response.status(200).json(await run(options.issues, { ...params, actorUserId: actor(response.locals),
      requestId: requestId(response.locals), update: parseBody(bodySchema, request.body) } as never));
  }));
}

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalid();
  return parsed.data;
}
function actor(locals: Record<string, unknown>) { return (locals as PlatformAuthLocals).platformAuth!.user.id; }
function invalid() { return new HttpProblem(400, "ISSUE_INPUT_INVALID", "Invalid request"); }
