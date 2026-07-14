import type { QueryResultRow } from "pg";
import { uuidV7Schema } from "../../../shared/contracts/common.ts";
import type { PlatformPool } from "../database/pool.ts";
import type { StorageObjectService } from "./storageObjectService.ts";

type ObjectRow = QueryResultRow & { media_type: string | null; size_bytes: string | number | null; allowed: boolean };

export class StorageAccessServiceError extends Error {
  constructor(readonly code: "STORAGE_ACCESS_INPUT_INVALID" | "STORAGE_ACCESS_NOT_FOUND" |
    "STORAGE_ACCESS_DEPENDENCY_UNAVAILABLE", options?: ErrorOptions) {
    super(code, options);
    this.name = "StorageAccessServiceError";
  }
}

export function createStorageAccessService(options: { readonly pool: PlatformPool;
  readonly storageObjects: StorageObjectService }) {
  if (!options?.pool || !options.storageObjects) throw new Error("STORAGE_ACCESS_OPTIONS_REQUIRED");
  return Object.freeze({
    async open(input: { actorUserId: string; objectId: string }) {
      const actorUserId = ownId(input?.actorUserId);
      const objectId = ownId(input?.objectId);
      try {
        const result = await options.pool.query<ObjectRow>(
          `SELECT object.media_type,object.size_bytes,
            (actor.platform_role='admin' OR EXISTS (
              SELECT 1 FROM platform.signature_assets signature
              WHERE signature.object_id=object.id AND signature.user_id=actor.id
            ) OR EXISTS (
              SELECT 1 FROM platform.project_members membership WHERE membership.user_id=actor.id
                AND membership.status='active' AND (
                  EXISTS (SELECT 1 FROM platform.drawing_revisions revision
                    WHERE revision.original_object_id=object.id AND revision.project_id=membership.project_id)
                  OR EXISTS (SELECT 1 FROM platform.render_artifacts artifact
                    WHERE artifact.object_id=object.id AND artifact.project_id=membership.project_id)
                  OR EXISTS (SELECT 1 FROM platform.print_archive_events archive
                    WHERE archive.object_id=object.id AND archive.project_id=membership.project_id)
                )
            )) AS allowed
           FROM platform.storage_objects object
           INNER JOIN platform.users actor ON actor.id=$1 AND actor.status='active'
           WHERE object.id=$2 AND object.status='ready'`, [actorUserId, objectId]
        );
        const object = result.rows[0];
        if (!object?.allowed || !object.media_type || object.size_bytes === null) throw notFound();
        const sizeBytes = Number(object.size_bytes);
        if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) throw dependency();
        return { body: await options.storageObjects.openRead(objectId), mediaType: object.media_type, sizeBytes };
      } catch (error) { throw owned(error); }
    }
  });
}

function ownId(value: unknown) { const parsed = uuidV7Schema.safeParse(value); if (!parsed.success)
  throw new StorageAccessServiceError("STORAGE_ACCESS_INPUT_INVALID"); return parsed.data; }
function notFound() { return new StorageAccessServiceError("STORAGE_ACCESS_NOT_FOUND"); }
function dependency(cause?: unknown) { return new StorageAccessServiceError("STORAGE_ACCESS_DEPENDENCY_UNAVAILABLE", { cause }); }
function owned(error: unknown) { return error instanceof StorageAccessServiceError ? error : dependency(error); }
