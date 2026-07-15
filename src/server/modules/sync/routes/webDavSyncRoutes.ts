import { Router } from "express";
import { z } from "zod";
import {
  createWebDavConnectionRequestSchema,
  createWebDavMappingRequestSchema,
  resolveWebDavConflictRequestSchema,
  retryWebDavSyncRequestSchema,
  testWebDavConnectionRequestSchema,
  triggerWebDavScanRequestSchema,
  updateWebDavConnectionRequestSchema,
  updateWebDavMappingRequestSchema,
  webDavConflictListQuerySchema,
  webDavSyncItemListQuerySchema
} from "../../../../shared/contracts/webdav.ts";
import { uuidV7Schema } from "../../../../shared/contracts/common.ts";
import { asyncRoute } from "../../../platform/http/asyncRoute.ts";
import { HttpProblem } from "../../../platform/http/problemResponse.ts";
import { createCsrfMiddleware, type CsrfProtection } from "../../../platform/security/csrf.ts";
import { createOriginGuard } from "../../../platform/security/originGuard.ts";
import { createSessionMiddleware, requirePlatformAuth, type PlatformAuthLocals,
  type SessionCookieConfig } from "../../../platform/security/sessionMiddleware.ts";
import { noStoreBusinessResponses } from "../../approvals/routes/approvalRoutes.ts";
import { parseBody, requestId } from "../../identity/routes/authRoutes.ts";
import type { createWebDavSyncService } from "../webDavSyncService.ts";

const connectionParams = z.object({ connectionId: uuidV7Schema }).strict();
const mappingParams = z.object({ mappingId: uuidV7Schema }).strict();
const syncItemParams = z.object({ syncItemId: uuidV7Schema }).strict();
const conflictParams = z.object({ conflictId: uuidV7Schema }).strict();
const mappingListQuery = z.object({ projectId: uuidV7Schema.optional() }).strict();

export function createWebDavSyncRoutes(options: {
  readonly webDavSync: ReturnType<typeof createWebDavSyncService>;
  readonly sessions: Parameters<typeof createSessionMiddleware>[0]["sessions"];
  readonly publicBaseUrl: string;
  readonly cookie: SessionCookieConfig;
  readonly csrf: CsrfProtection;
}) {
  if (!options?.webDavSync) throw new Error("WEBDAV_SYNC_ROUTES_SERVICE_REQUIRED");
  const router = Router();
  const session = createSessionMiddleware({ cookieName: options.cookie.name, sessions: options.sessions });
  const auth = [session, requirePlatformAuth] as const;
  const mutate = [createOriginGuard({ publicBaseUrl: options.publicBaseUrl }), session, requirePlatformAuth,
    createCsrfMiddleware({ csrf: options.csrf })] as const;
  router.use(noStoreBusinessResponses);

  router.get("/summary", ...auth, asyncRoute(async (_request, response) => {
    response.status(200).json(await options.webDavSync.getSummary({ actorUserId: actor(response.locals) }));
  }));
  router.get("/connections", ...auth, asyncRoute(async (_request, response) => {
    response.status(200).json(await options.webDavSync.listConnections({ actorUserId: actor(response.locals) }));
  }));
  router.post("/connections", ...mutate, asyncRoute(async (request, response) => {
    response.status(201).json(await options.webDavSync.createConnection({ actorUserId: actor(response.locals),
      requestId: requestId(response.locals), update: parseBody(createWebDavConnectionRequestSchema, request.body) }));
  }));
  router.patch("/connections/:connectionId", ...mutate, asyncRoute(async (request, response) => {
    const params = parse(connectionParams, request.params);
    response.status(200).json(await options.webDavSync.updateConnection({ actorUserId: actor(response.locals),
      connectionId: params.connectionId, requestId: requestId(response.locals),
      update: parseBody(updateWebDavConnectionRequestSchema, request.body) }));
  }));
  router.post("/connections/:connectionId/test", ...mutate, asyncRoute(async (request, response) => {
    const params = parse(connectionParams, request.params);
    response.status(202).json(await options.webDavSync.testConnection({ actorUserId: actor(response.locals),
      connectionId: params.connectionId, requestId: requestId(response.locals),
      update: parseBody(testWebDavConnectionRequestSchema, request.body) }));
  }));

  router.get("/mappings", ...auth, asyncRoute(async (request, response) => {
    const query = parse(mappingListQuery, request.query);
    response.status(200).json(await options.webDavSync.listMappings({ actorUserId: actor(response.locals), ...query }));
  }));
  router.post("/mappings", ...mutate, asyncRoute(async (request, response) => {
    response.status(201).json(await options.webDavSync.createMapping({ actorUserId: actor(response.locals),
      requestId: requestId(response.locals), update: parseBody(createWebDavMappingRequestSchema, request.body) }));
  }));
  router.patch("/mappings/:mappingId", ...mutate, asyncRoute(async (request, response) => {
    const params = parse(mappingParams, request.params);
    response.status(200).json(await options.webDavSync.updateMapping({ actorUserId: actor(response.locals),
      mappingId: params.mappingId, requestId: requestId(response.locals),
      update: parseBody(updateWebDavMappingRequestSchema, request.body) }));
  }));
  router.post("/scans", ...mutate, asyncRoute(async (request, response) => {
    response.status(202).json(await options.webDavSync.triggerScan({ actorUserId: actor(response.locals),
      requestId: requestId(response.locals), update: parseBody(triggerWebDavScanRequestSchema, request.body) }));
  }));

  router.get("/items", ...auth, asyncRoute(async (request, response) => {
    const query = parse(webDavSyncItemListQuerySchema, request.query);
    response.status(200).json(await options.webDavSync.listSyncItems({ actorUserId: actor(response.locals), ...query }));
  }));
  router.post("/items/:syncItemId/retry", ...mutate, asyncRoute(async (request, response) => {
    const params = parse(syncItemParams, request.params);
    response.status(202).json(await options.webDavSync.retrySyncItem({ actorUserId: actor(response.locals),
      syncItemId: params.syncItemId, requestId: requestId(response.locals),
      update: parseBody(retryWebDavSyncRequestSchema, request.body) }));
  }));
  router.get("/conflicts", ...auth, asyncRoute(async (request, response) => {
    const query = parse(webDavConflictListQuerySchema, request.query);
    response.status(200).json(await options.webDavSync.listConflicts({ actorUserId: actor(response.locals), ...query }));
  }));
  router.post("/conflicts/:conflictId/resolve", ...mutate, asyncRoute(async (request, response) => {
    const params = parse(conflictParams, request.params);
    response.status(200).json(await options.webDavSync.resolveConflict({ actorUserId: actor(response.locals),
      conflictId: params.conflictId, requestId: requestId(response.locals),
      update: parseBody(resolveWebDavConflictRequestSchema, request.body) }));
  }));
  return router;
}

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpProblem(400, "WEBDAV_SYNC_INPUT_INVALID", "Invalid request");
  return parsed.data;
}
function actor(locals: Record<string, unknown>) { return (locals as PlatformAuthLocals).platformAuth!.user.id; }
