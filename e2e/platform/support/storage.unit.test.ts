import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { StorageAdapter } from "../../../src/server/platform/storage/storageAdapter.ts";
import { createPrefixedStorage } from "./storage.ts";

const logicalKey = "drawings/01890f1e-9b4a-7cc2-8f00-000000000001";
const physicalPrefix = "phase1-e2e/abcdef0123456789";

describe("platform E2E prefixed storage", () => {
  it("maps every logical object operation into the owned physical prefix", async () => {
    const underlying = fakeStorage();
    const storage = createPrefixedStorage(underlying, physicalPrefix);

    await storage.write(logicalKey, Readable.from("drawing"), "application/pdf");
    await storage.openRead(logicalKey);
    await storage.head(logicalKey);
    await storage.delete(logicalKey);

    const expected = `${physicalPrefix}/${logicalKey}`;
    expect(underlying.write).toHaveBeenCalledWith(expected, expect.any(Readable), "application/pdf", undefined);
    expect(underlying.openRead).toHaveBeenCalledWith(expected, undefined);
    expect(underlying.head).toHaveBeenCalledWith(expected, undefined);
    expect(underlying.delete).toHaveBeenCalledWith(expected, undefined);
  });

  it("runs health write/read/head/delete only inside the owned prefix", async () => {
    const physicalKeys: string[] = [];
    const bodies = new Map<string, Buffer>();
    const underlying = fakeStorage({
      write: vi.fn(async (key: string, body: Readable) => {
        const chunks: Buffer[] = [];
        for await (const chunk of body) chunks.push(Buffer.from(chunk));
        const value = Buffer.concat(chunks);
        physicalKeys.push(key);
        bodies.set(key, value);
        return { sizeBytes: value.length, sha256: Buffer.alloc(32) };
      }),
      openRead: vi.fn(async (key: string) => { physicalKeys.push(key); return Readable.from(bodies.get(key)!); }),
      head: vi.fn(async (key: string) => { physicalKeys.push(key); return { sizeBytes: bodies.get(key)!.length }; }),
      delete: vi.fn(async (key: string) => { physicalKeys.push(key); bodies.delete(key); })
    });

    await createPrefixedStorage(underlying, physicalPrefix).checkHealth();

    expect(underlying.checkHealth).not.toHaveBeenCalled();
    expect(physicalKeys).toHaveLength(4);
    expect(physicalKeys.every((key) => key.startsWith(`${physicalPrefix}/health/`))).toBe(true);
  });
});

function fakeStorage(overrides: Partial<StorageAdapter> = {}) {
  return {
    driver: "s3" as const,
    write: vi.fn(async () => ({ sizeBytes: 1, sha256: Buffer.alloc(32) })),
    openRead: vi.fn(async () => Readable.from("drawing")),
    head: vi.fn(async () => ({ sizeBytes: 1 })),
    delete: vi.fn(async () => undefined),
    checkHealth: vi.fn(async () => undefined),
    ...overrides
  } satisfies StorageAdapter;
}
