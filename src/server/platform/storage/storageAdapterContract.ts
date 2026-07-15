import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import type { StorageAdapter, StorageDriver } from "./storageAdapter";
import { createStorageKey } from "./storageKey";

export interface StorageAdapterContractHarness {
  readonly adapter: StorageAdapter;
  cleanup?(): Promise<void>;
}

type MaybePromise<T> = T | Promise<T>;

export function storageAdapterContract(
  name: string,
  expectedDriver: StorageDriver,
  createHarness: () => MaybePromise<StorageAdapterContractHarness>,
): void {
  describe(`${name} StorageAdapter contract`, () => {
    let harness: StorageAdapterContractHarness;

    beforeEach(async () => {
      harness = await createHarness();
    });

    afterEach(async () => {
      await harness.cleanup?.();
    });

    it("exposes the configured driver", () => {
      expect(harness.adapter.driver).toBe(expectedDriver);
    });

    it("streams an object while reporting its byte count and SHA-256", async () => {
      const key = newObjectKey();
      const chunks = [Buffer.from("precision "), Buffer.from("drawing "), Buffer.from("review")];
      const expectedBody = Buffer.concat(chunks);

      const result = await harness.adapter.write(key, Readable.from(chunks), "application/pdf");

      expect(result.sizeBytes).toBe(expectedBody.byteLength);
      expect(result.sha256).toEqual(createHash("sha256").update(expectedBody).digest());
      const body = await readAll(await harness.adapter.openRead(key));
      expect(body).toEqual(expectedBody);
      expect(await harness.adapter.head(key)).toEqual({ sizeBytes: expectedBody.byteLength });
    });

    it("never overwrites an existing object and preserves its original bytes", async () => {
      const key = newObjectKey();
      const original = Buffer.from("approved revision");
      await harness.adapter.write(key, Readable.from([original]), "application/pdf");

      await expect(
        harness.adapter.write(key, Readable.from([Buffer.from("replacement")]), "application/pdf"),
      ).rejects.toMatchObject({ code: "OBJECT_EXISTS" });

      expect(await readAll(await harness.adapter.openRead(key))).toEqual(original);
    });

    it("atomically admits exactly one of two concurrent writers", async () => {
      const key = newObjectKey();
      const first = Buffer.from("first complete candidate");
      const second = Buffer.from("second complete candidate");

      const results = await Promise.allSettled([
        harness.adapter.write(
          key,
          Readable.from([first.subarray(0, 5), first.subarray(5)]),
          "application/pdf",
        ),
        harness.adapter.write(
          key,
          Readable.from([second.subarray(0, 7), second.subarray(7)]),
          "application/pdf",
        ),
      ]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.find((result) => result.status === "rejected")).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({ code: "OBJECT_EXISTS" }),
      });

      const stored = await readAll(await harness.adapter.openRead(key));
      expect([stored.equals(first), stored.equals(second)]).toContain(true);
    });

    it("returns stable missing-object results", async () => {
      const key = newObjectKey();

      await expect(harness.adapter.openRead(key)).rejects.toMatchObject({ code: "OBJECT_NOT_FOUND" });
      await expect(harness.adapter.head(key)).resolves.toBeNull();
    });

    it("does not publish a final object when the input stream fails", async () => {
      const key = newObjectKey();

      await expect(
        harness.adapter.write(key, failingReadable(), "application/pdf"),
      ).rejects.toMatchObject({ code: "STORAGE_IO_ERROR" });
      await expect(harness.adapter.head(key)).resolves.toBeNull();

      const retryBody = Buffer.from("retry succeeds");
      await expect(
        harness.adapter.write(key, Readable.from([retryBody]), "application/pdf"),
      ).resolves.toMatchObject({ sizeBytes: retryBody.byteLength });
    });

    it("aborts an in-flight write and leaves no readable object", async () => {
      const key = createStorageKey("objects/original", uuidv7());
      let entered!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const body = new Readable({ read() { entered(); } });
      const controller = new AbortController();
      const writing = harness.adapter.write(key, body, "application/pdf", { signal: controller.signal });
      await started;
      controller.abort();
      await expect(writing).rejects.toMatchObject({ code: "STORAGE_IO_ERROR" });
      await expect(harness.adapter.head(key)).resolves.toBeNull();
      expect(body.destroyed).toBe(true);
    });

    it("deletes idempotently", async () => {
      const key = newObjectKey();
      await harness.adapter.write(key, Readable.from([Buffer.from("temporary")]), "application/pdf");

      await expect(harness.adapter.delete(key)).resolves.toBeUndefined();
      await expect(harness.adapter.delete(key)).resolves.toBeUndefined();
      await expect(harness.adapter.head(key)).resolves.toBeNull();
    });

    it("passes its active health probe", async () => {
      await expect(harness.adapter.checkHealth()).resolves.toBeUndefined();
    });
  });
}

function newObjectKey(): string {
  return createStorageKey("objects/original", uuidv7());
}

async function readAll(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function failingReadable(): Readable {
  let readCount = 0;
  return new Readable({
    read() {
      if (readCount === 0) {
        readCount += 1;
        this.push(Buffer.from("partial payload"));
        return;
      }
      this.destroy(new Error("synthetic input failure"));
    },
  });
}
