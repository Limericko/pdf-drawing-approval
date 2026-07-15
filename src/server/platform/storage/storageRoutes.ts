import { Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Router } from "express";
import { z } from "zod";
import { uuidV7Schema } from "../../../shared/contracts/common.ts";
import { asyncRoute } from "../http/asyncRoute.ts";
import { HttpProblem } from "../http/problemResponse.ts";
import { createCsrfMiddleware, type CsrfProtection } from "../security/csrf.ts";
import { createOriginGuard } from "../security/originGuard.ts";
import { createSessionMiddleware, requirePlatformAuth, type SessionCookieConfig } from "../security/sessionMiddleware.ts";
import type { StorageObjectService } from "./storageObjectService.ts";
import type { createStorageAccessService } from "./storageAccessService.ts";
import type { PlatformAuthLocals } from "../security/sessionMiddleware.ts";

const MAX_PDF_BYTES = 256 * 1024 * 1024;
const MAX_PNG_BYTES = 8 * 1024 * 1024;

export function createStorageRoutes(options: {
  readonly storageObjects: StorageObjectService;
  readonly storageAccess: ReturnType<typeof createStorageAccessService>;
  readonly sessions: Parameters<typeof createSessionMiddleware>[0]["sessions"];
  readonly publicBaseUrl: string;
  readonly cookie: SessionCookieConfig;
  readonly csrf: CsrfProtection;
}) {
  if (!options?.storageObjects || !options.storageAccess) throw new Error("STORAGE_ROUTES_SERVICE_REQUIRED");
  const router = Router();
  const session = createSessionMiddleware({ cookieName: options.cookie.name, sessions: options.sessions });
  const mutating = [createOriginGuard({ publicBaseUrl: options.publicBaseUrl,
    contentTypes: ["application/pdf", "image/png"] }), session, requirePlatformAuth,
    createCsrfMiddleware({ csrf: options.csrf })] as const;
  router.post("/objects", ...mutating, asyncRoute(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const mediaType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== "application/pdf" && mediaType !== "image/png") throw invalidType();
    const maximum = mediaType === "application/pdf" ? MAX_PDF_BYTES : MAX_PNG_BYTES;
    const length = request.headers["content-length"];
    if (length !== undefined && (!/^(?:0|[1-9]\d*)$/.test(length) || Number(length) > maximum)) {
      throw tooLarge();
    }
    const bounded = new ByteLimitTransform(maximum);
    request.pipe(bounded);
    const object = await options.storageObjects.create({ body: bounded, mediaType });
    response.status(201).json({ id: object.id, mediaType, sizeBytes: object.sizeBytes,
      sha256: object.sha256!.toString("hex") });
  }));
  router.get("/objects/:objectId/content", session, requirePlatformAuth, asyncRoute(async (request, response) => {
    const params = z.object({ objectId: uuidV7Schema }).strict().safeParse(request.params);
    if (!params.success) throw new HttpProblem(400, "STORAGE_ACCESS_INPUT_INVALID", "Invalid request");
    const actor = (response.locals as PlatformAuthLocals).platformAuth!.user;
    const object = await options.storageAccess.open({ actorUserId: actor.id, objectId: params.data.objectId });
    response.status(200);
    response.setHeader("Content-Type", object.mediaType);
    response.setHeader("Content-Length", String(object.sizeBytes));
    response.setHeader("Content-Disposition", "inline");
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    await pipeline(object.body, response);
  }));
  return router;
}

class ByteLimitTransform extends Transform {
  private size = 0;
  constructor(private readonly maximum: number) { super(); }
  override _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    this.size += buffer.length;
    if (this.size > this.maximum) { callback(tooLarge()); return; }
    callback(null, buffer);
  }
  override _flush(callback: TransformCallback) {
    if (this.size === 0) { callback(new HttpProblem(400, "STORAGE_BODY_EMPTY", "Upload body is empty")); return; }
    callback();
  }
}

function invalidType() {
  return new HttpProblem(415, "STORAGE_MEDIA_TYPE_UNSUPPORTED", "Unsupported media type");
}

function tooLarge() {
  return new HttpProblem(413, "STORAGE_BODY_TOO_LARGE", "Upload is too large");
}
