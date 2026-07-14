import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { StorageAdapter } from "../storage/storageAdapter.ts";
import { StorageError } from "../storage/storageErrors.ts";
import { importLegacyFileObject, type LegacyFileImportStore } from "./legacyFileImporter.ts";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((target) => rm(target, { recursive: true, force: true }))));

describe("legacy file importer", () => {
  it("uploads, reads back, records and reuses an exact file mapping", async () => {
    const fixture = await fileFixture();
    const storage = memoryStorage();
    const store = memoryStore(storage);
    const base = { runId: "run", sourceId: "office-server-2026", sourcePathSha256: "a".repeat(64),
      sourceContentSha256: fixture.sha256, absolutePath: fixture.filePath, sizeBytes: fixture.bytes.length,
      mediaType: "application/pdf" as const, storage, store, now: () => new Date("2026-07-14T16:00:00Z") };

    const first = await importLegacyFileObject(base);
    const second = await importLegacyFileObject(base);
    expect(first.reused).toBe(false);
    expect(second).toEqual({ storageObjectId: first.storageObjectId, reused: true });
    expect(storage.writes).toBe(1);
    expect(store.mappingWrites).toBe(2);
  });

  it("recovers when deterministic object bytes exist but metadata was not committed", async () => {
    const fixture = await fileFixture();
    const storage = memoryStorage();
    const store = memoryStore(storage);
    const input = { runId: "run", sourceId: "office-server-2026", sourcePathSha256: "b".repeat(64),
      sourceContentSha256: fixture.sha256, absolutePath: fixture.filePath, sizeBytes: fixture.bytes.length,
      mediaType: "application/pdf" as const, storage, store };
    const first = await importLegacyFileObject(input);
    store.mapping = undefined;
    storage.failNextAsExists = true;
    const recovered = await importLegacyFileObject(input);
    expect(recovered).toEqual({ storageObjectId: first.storageObjectId, reused: false });
  });

  it("fails closed when the source changes after preflight", async () => {
    const fixture = await fileFixture();
    const storage = memoryStorage();
    const store = memoryStore(storage);
    await writeFile(fixture.filePath, Buffer.from("changed"));
    await expect(importLegacyFileObject({ runId: "run", sourceId: "office-server-2026",
      sourcePathSha256: "c".repeat(64), sourceContentSha256: fixture.sha256,
      absolutePath: fixture.filePath, sizeBytes: fixture.bytes.length, mediaType: "application/pdf",
      storage, store })).rejects.toThrow("LEGACY_FILE_CHANGED_AFTER_PREFLIGHT");
  });
});

async function fileFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "legacy-file-import-"));
  cleanup.push(root);
  const bytes = Buffer.from("%PDF-safe-fixture");
  const filePath = path.join(root, "drawing.pdf");
  await writeFile(filePath, bytes);
  return { bytes, filePath, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function memoryStorage(): StorageAdapter & { writes: number; failNextAsExists: boolean } {
  const objects = new Map<string, Buffer>();
  return {
    driver: "s3", writes: 0, failNextAsExists: false,
    async write(key, body) {
      if (this.failNextAsExists) { this.failNextAsExists = false; throw new StorageError("OBJECT_EXISTS", "exists"); }
      const chunks: Buffer[] = []; for await (const chunk of body) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks); objects.set(key, bytes); this.writes += 1;
      return { sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest() };
    },
    async openRead(key) { const bytes = objects.get(key); if (!bytes) throw new Error("missing"); return Readable.from([bytes]); },
    async head(key) { const bytes = objects.get(key); return bytes ? { sizeBytes: bytes.length } : null; },
    async delete(key) { objects.delete(key); }, async checkHealth() {}
  };
}

function memoryStore(storage: StorageAdapter): LegacyFileImportStore & {
  mapping?: Awaited<ReturnType<LegacyFileImportStore["findFileMapping"]>>; mappingWrites: number;
} {
  return {
    mapping: undefined, mappingWrites: 0,
    async findFileMapping() { return this.mapping; },
    async ensureReadyStorageObject() {},
    async recordFileMapping(input) {
      this.mappingWrites += 1;
      this.mapping = { sourceContentSha256: input.sourceContentSha256, sizeBytes: input.sizeBytes,
        mediaType: input.mediaType, storageObjectId: input.storageObjectId, status: "ready",
        driver: storage.driver, objectKey: `migration/legacy/${input.storageObjectId}` };
    }
  };
}
