import { Readable } from "node:stream";
import { v7 as uuidv7 } from "uuid";
import { assertStorageKey, createStorageKey } from "../../../src/server/platform/storage/storageKey.ts";
import type { StorageAdapter } from "../../../src/server/platform/storage/storageAdapter.ts";

const HEALTH_PAYLOAD = Buffer.from("platform-e2e-storage-health", "utf8");
const PREFIX_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;

export function createPrefixedStorage(adapter: StorageAdapter, physicalPrefix: string) {
  if (!adapter || !PREFIX_PATTERN.test(physicalPrefix) || physicalPrefix.length > 255) {
    throw new Error("PLATFORM_E2E_STORAGE_PREFIX_INVALID");
  }
  const physicalKey = (logicalKey: string) => {
    assertStorageKey(logicalKey);
    const mapped = `${physicalPrefix}/${logicalKey}`;
    assertStorageKey(mapped);
    return mapped;
  };
  return Object.freeze({
    driver: adapter.driver,
    write(key: string, body: Readable, contentType: string, options?: { readonly signal?: AbortSignal }) {
      return adapter.write(physicalKey(key), body, contentType, options);
    },
    openRead(key: string, options?: { readonly signal?: AbortSignal }) {
      return adapter.openRead(physicalKey(key), options);
    },
    head(key: string, options?: { readonly signal?: AbortSignal }) {
      return adapter.head(physicalKey(key), options);
    },
    delete(key: string, options?: { readonly signal?: AbortSignal }) {
      return adapter.delete(physicalKey(key), options);
    },
    async checkHealth(options?: { readonly signal?: AbortSignal }) {
      const key = physicalKey(createStorageKey("health", uuidv7()));
      try {
        const written = await adapter.write(key, Readable.from(HEALTH_PAYLOAD), "application/octet-stream", options);
        const head = await adapter.head(key, options);
        const body = await readAll(await adapter.openRead(key, options));
        if (written.sizeBytes !== HEALTH_PAYLOAD.length || head?.sizeBytes !== HEALTH_PAYLOAD.length ||
            !body.equals(HEALTH_PAYLOAD)) throw new Error("PLATFORM_E2E_STORAGE_HEALTH_FAILED");
      } finally {
        await adapter.delete(key, options);
      }
    },
    destroy() {
      if ("destroy" in adapter && typeof adapter.destroy === "function") adapter.destroy();
    }
  }) satisfies StorageAdapter & { destroy(): void };
}

async function readAll(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
