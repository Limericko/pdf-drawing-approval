import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import type { Readable } from "node:stream";
import type { StorageAdapter } from "../storage/storageAdapter.ts";
import { StorageError } from "../storage/storageErrors.ts";
import { createStorageKey } from "../storage/storageKey.ts";
import { deriveLegacyUuidV7 } from "./legacyIdentity.ts";

type ExistingFileMapping = {
  readonly sourceContentSha256: string;
  readonly sizeBytes: number;
  readonly mediaType: string;
  readonly storageObjectId: string;
  readonly status: string;
  readonly driver: string;
  readonly objectKey: string;
};

export type LegacyFileImportStore = {
  findFileMapping(sourceId: string, sourcePathSha256: string, sourceContentSha256: string):
    Promise<ExistingFileMapping | undefined>;
  ensureReadyStorageObject(input: {
    readonly id: string; readonly driver: "filesystem" | "s3"; readonly objectKey: string;
    readonly sizeBytes: number; readonly sha256: string; readonly mediaType: string; readonly readyAt: Date;
  }): Promise<void>;
  recordFileMapping(input: {
    readonly runId: string; readonly sourceId: string; readonly sourcePathSha256: string;
    readonly sourceContentSha256: string; readonly sizeBytes: number; readonly mediaType: string;
    readonly storageObjectId: string; readonly verifiedAt: Date;
  }): Promise<void>;
};

export async function importLegacyFileObject(input: {
  readonly runId: string;
  readonly sourceId: string;
  readonly sourcePathSha256: string;
  readonly sourceContentSha256: string;
  readonly absolutePath: string;
  readonly sizeBytes: number;
  readonly mediaType: "application/pdf" | "image/png";
  readonly storage: StorageAdapter;
  readonly store: LegacyFileImportStore;
  readonly now?: () => Date;
}) {
  assertHex(input.sourcePathSha256);
  assertHex(input.sourceContentSha256);
  const metadata = await lstat(input.absolutePath).catch(() => null);
  if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.size !== input.sizeBytes || input.sizeBytes <= 0) {
    throw new Error("LEGACY_FILE_CHANGED_AFTER_PREFLIGHT");
  }
  const currentHash = await hashReadable(createReadStream(input.absolutePath));
  if (currentHash !== input.sourceContentSha256) throw new Error("LEGACY_FILE_CHANGED_AFTER_PREFLIGHT");

  const existing = await input.store.findFileMapping(
    input.sourceId,
    input.sourcePathSha256,
    input.sourceContentSha256
  );
  if (existing) {
    if (
      existing.sourceContentSha256 !== input.sourceContentSha256 || existing.sizeBytes !== input.sizeBytes ||
      existing.mediaType !== input.mediaType || existing.status !== "ready" || existing.driver !== input.storage.driver
    ) {
      throw new Error("LEGACY_FILE_MAPPING_CONFLICT");
    }
    await verifyStoredBytes(input.storage, existing.objectKey, input.sizeBytes, input.sourceContentSha256);
    await input.store.recordFileMapping({ runId: input.runId, sourceId: input.sourceId,
      sourcePathSha256: input.sourcePathSha256, sourceContentSha256: input.sourceContentSha256,
      sizeBytes: input.sizeBytes, mediaType: input.mediaType, storageObjectId: existing.storageObjectId,
      verifiedAt: now(input.now) });
    return { storageObjectId: existing.storageObjectId, reused: true } as const;
  }

  const storageObjectId = deriveLegacyUuidV7(
    input.sourceId,
    "file_object",
    `${input.sourcePathSha256}:${input.sourceContentSha256}`
  );
  const objectKey = createStorageKey("migration/legacy", storageObjectId);
  try {
    const written = await input.storage.write(objectKey, createReadStream(input.absolutePath), input.mediaType);
    if (written.sizeBytes !== input.sizeBytes || written.sha256.toString("hex") !== input.sourceContentSha256) {
      throw new Error("LEGACY_FILE_UPLOAD_MISMATCH");
    }
  } catch (error) {
    if (!(error instanceof StorageError) || error.code !== "OBJECT_EXISTS") throw error;
  }
  await verifyStoredBytes(input.storage, objectKey, input.sizeBytes, input.sourceContentSha256);
  const verifiedAt = now(input.now);
  await input.store.ensureReadyStorageObject({ id: storageObjectId, driver: input.storage.driver, objectKey,
    sizeBytes: input.sizeBytes, sha256: input.sourceContentSha256, mediaType: input.mediaType, readyAt: verifiedAt });
  await input.store.recordFileMapping({ runId: input.runId, sourceId: input.sourceId,
    sourcePathSha256: input.sourcePathSha256, sourceContentSha256: input.sourceContentSha256,
    sizeBytes: input.sizeBytes, mediaType: input.mediaType, storageObjectId, verifiedAt });
  return { storageObjectId, reused: false } as const;
}

async function verifyStoredBytes(storage: StorageAdapter, objectKey: string, sizeBytes: number, sha256: string) {
  const head = await storage.head(objectKey);
  if (!head || head.sizeBytes !== sizeBytes) throw new Error("LEGACY_FILE_HEAD_MISMATCH");
  const storedHash = await hashReadable(await storage.openRead(objectKey));
  if (storedHash !== sha256) throw new Error("LEGACY_FILE_READBACK_MISMATCH");
}

async function hashReadable(readable: Readable) {
  const hash = createHash("sha256");
  for await (const chunk of readable) hash.update(chunk);
  return hash.digest("hex");
}

function assertHex(value: string) {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("LEGACY_FILE_IMPORT_INPUT_INVALID");
}

function now(clock: (() => Date) | undefined) {
  const value = (clock ?? (() => new Date()))();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("LEGACY_FILE_IMPORT_CLOCK_INVALID");
  return new Date(value);
}
