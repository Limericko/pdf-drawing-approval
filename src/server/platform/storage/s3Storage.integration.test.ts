import { PutObjectCommand } from "@aws-sdk/client-s3";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, describe, expect, it, vi } from "vitest";
import { v7 as uuidv7 } from "uuid";
import type { S3StorageConfig } from "../config/types";
import type {
  StorageAdapter,
  StorageHeadResult,
  StorageWriteResult,
} from "./storageAdapter";
import { storageAdapterContract } from "./storageAdapterContract";
import { createStorageKey } from "./storageKey";
import { S3Storage } from "./s3Storage";

const config = readS3Config();
const sharedStorage = new S3Storage(config);

storageAdapterContract("S3/MinIO", "s3", () => {
  const adapter = new TrackingStorageAdapter(sharedStorage);
  return {
    adapter,
    cleanup: () => adapter.cleanup(),
  };
});

describe("S3Storage MinIO boundaries", () => {
  it("does not disguise a real missing MinIO bucket as a missing object", async () => {
    const storage = new S3Storage({
      ...config,
      bucket: `pdf-approval-missing-${uuidv7()}`,
    });
    try {
      await expect(storage.head(objectKey())).rejects.toMatchObject({
        code: "STORAGE_IO_ERROR",
      });
    } finally {
      storage.destroy();
    }
  });

  it("keeps newly written objects inaccessible to anonymous callers", async () => {
    const key = createStorageKey("objects/original", uuidv7());
    try {
      await sharedStorage.write(key, Readable.from(["private drawing"]), "application/pdf");
      await expect(sharedStorage.head(key)).resolves.toEqual({
        sizeBytes: Buffer.byteLength("private drawing"),
      });

      const response = await fetch(anonymousObjectUrl(config, key), { redirect: "manual" });

      expect(response.status).toBe(403);
    } finally {
      await sharedStorage.delete(key);
    }
  });

  it("rejects a stream before the chunk that crosses the configured single-PUT limit", async () => {
    const storage = new S3Storage({ ...config, maxObjectBytes: 4 });
    const key = createStorageKey("objects/original", uuidv7());
    try {
      await expect(
        storage.write(key, Readable.from([Buffer.from("1234"), Buffer.from("5")]), "application/pdf"),
      ).rejects.toMatchObject({ code: "OBJECT_TOO_LARGE" });
      await expect(storage.head(key)).resolves.toBeNull();
    } finally {
      await storage.delete(key);
      storage.destroy();
    }
  });

  it("does not let SDK diagnostics bypass sanitized storage errors", async () => {
    const key = createStorageKey("objects/original", uuidv7());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await sharedStorage.write(key, Readable.from(["original"]), "application/pdf");
      await expect(
        sharedStorage.write(key, Readable.from(["replacement"]), "application/pdf"),
      ).rejects.toMatchObject({ code: "OBJECT_EXISTS" });

      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      await sharedStorage.delete(key);
    }
  });
});

describe("S3Storage two-stage streaming cleanup", () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 5 * 1024 ** 3])(
    "rejects the invalid single-PUT byte limit %s",
    (maxObjectBytes) => {
      expect(() => new S3Storage({ ...config, maxObjectBytes })).toThrowError(
        expect.objectContaining({ code: "OBJECT_TOO_LARGE" }),
      );
    },
  );

  it("rejects a relative spool parent without exposing it", () => {
    const sensitivePath = "relative/secret-spool";
    expect(() => new S3Storage({ ...config, spoolParent: sensitivePath })).toThrowError(
      expect.objectContaining({ code: "INVALID_STORAGE_ROOT" }),
    );
    try {
      new S3Storage({ ...config, spoolParent: sensitivePath });
    } catch (error) {
      expect(String(error)).not.toContain(sensitivePath);
    }
  });

  it.each([
    {
      name: "input failure",
      body: () => failingReadable(),
      maxObjectBytes: 1024,
      expectedCode: "STORAGE_IO_ERROR",
    },
    {
      name: "object limit",
      body: () => Readable.from([Buffer.from("1234"), Buffer.from("5")]),
      maxObjectBytes: 4,
      expectedCode: "OBJECT_TOO_LARGE",
    },
  ])("does not call PutObject after $name and removes its spool", async ({
    body,
    maxObjectBytes,
    expectedCode,
  }) => {
    const spoolParent = await mkdtemp(join(tmpdir(), "pdf-approval-s3-spool-test-"));
    let putCalls = 0;
    const storage = new S3Storage(
      { ...config, maxObjectBytes, spoolParent },
      {
        async send(command) {
          if (command instanceof PutObjectCommand) {
            putCalls += 1;
          }
          throw new Error("S3 must not be called before spooling succeeds");
        },
      },
    );
    try {
      await expect(storage.write(objectKey(), body(), "application/pdf")).rejects.toMatchObject({
        code: expectedCode,
      });
      expect(putCalls).toBe(0);
      expect(await readdir(spoolParent)).toEqual([]);
    } finally {
      storage.destroy();
      await rm(spoolParent, { force: true, recursive: true });
    }
  });

  it("does not disguise a missing bucket as a missing object", async () => {
    const missingBucket = Object.assign(new Error("synthetic missing bucket"), {
      name: "NoSuchBucket",
      $metadata: { httpStatusCode: 404 },
    });
    const storage = new S3Storage(config, {
      async send() {
        throw missingBucket;
      },
    });
    try {
      await expect(storage.head(objectKey())).rejects.toMatchObject({ code: "STORAGE_IO_ERROR" });
      await expect(storage.openRead(objectKey())).rejects.toMatchObject({
        code: "STORAGE_IO_ERROR",
      });
    } finally {
      storage.destroy();
    }
  });

  it("maps AWS ConditionalRequestConflict to the stable write-conflict error", async () => {
    const conflict = Object.assign(new Error("synthetic conditional conflict"), {
      name: "ConditionalRequestConflict",
      $metadata: { httpStatusCode: 409 },
    });
    const storage = new S3Storage(config, {
      async send() {
        throw conflict;
      },
    });
    try {
      await expect(
        storage.write(objectKey(), Readable.from(["candidate"]), "application/pdf"),
      ).rejects.toMatchObject({ code: "OBJECT_EXISTS" });
    } finally {
      storage.destroy();
    }
  });

  it("maps object body stream failures and closes the source", async () => {
    const source = failingReadable();
    const storage = new S3Storage(config, {
      async send() {
        return { Body: source };
      },
    });
    try {
      await expect(consume(await storage.openRead(objectKey()))).rejects.toMatchObject({
        code: "STORAGE_IO_ERROR",
      });
      expect(source.destroyed).toBe(true);
    } finally {
      storage.destroy();
    }
  });

  it("sends exact ContentLength once and removes its spool after PutObject fails", async () => {
    const spoolParent = await mkdtemp(join(tmpdir(), "pdf-approval-s3-spool-test-"));
    const payload = Buffer.from("spooled drawing");
    let putCalls = 0;
    let contentLength: number | undefined;
    const storage = new S3Storage(
      { ...config, spoolParent },
      {
        async send(command) {
          if (!(command instanceof PutObjectCommand)) {
            throw new Error("Unexpected S3 command");
          }
          putCalls += 1;
          contentLength = command.input.ContentLength;
          if (!(command.input.Body instanceof Readable)) {
            throw new Error("PutObject body must remain a Node stream");
          }
          for await (const _chunk of command.input.Body) {
            // Consume the stream like the Node HTTP handler before simulating a service failure.
          }
          throw new Error("synthetic PutObject failure");
        },
      },
    );
    try {
      await expect(
        storage.write(objectKey(), Readable.from([payload]), "application/pdf"),
      ).rejects.toMatchObject({ code: "STORAGE_IO_ERROR" });
      expect(putCalls).toBe(1);
      expect(contentLength).toBe(payload.byteLength);
      expect(await readdir(spoolParent)).toEqual([]);
    } finally {
      storage.destroy();
      await rm(spoolParent, { force: true, recursive: true });
    }
  });
});

afterAll(() => {
  sharedStorage.destroy();
});

class TrackingStorageAdapter implements StorageAdapter {
  readonly driver = "s3" as const;
  private readonly keys = new Set<string>();

  constructor(private readonly storage: S3Storage) {}

  write(key: string, body: Readable, contentType: string): Promise<StorageWriteResult> {
    this.keys.add(key);
    return this.storage.write(key, body, contentType);
  }

  openRead(key: string): Promise<Readable> {
    return this.storage.openRead(key);
  }

  head(key: string): Promise<StorageHeadResult | null> {
    return this.storage.head(key);
  }

  delete(key: string): Promise<void> {
    return this.storage.delete(key);
  }

  checkHealth(): Promise<void> {
    return this.storage.checkHealth();
  }

  async cleanup(): Promise<void> {
    const keys = [...this.keys];
    this.keys.clear();
    await Promise.all(keys.map((key) => this.storage.delete(key)));
  }
}

function readS3Config(): S3StorageConfig {
  return {
    driver: "s3",
    endpoint: requiredEnv("PDF_APPROVAL_STORAGE_S3_ENDPOINT"),
    region: requiredEnv("PDF_APPROVAL_STORAGE_S3_REGION"),
    bucket: requiredEnv("PDF_APPROVAL_STORAGE_S3_BUCKET"),
    accessKey: requiredEnv("PDF_APPROVAL_STORAGE_S3_ACCESS_KEY"),
    secretKey: requiredEnv("PDF_APPROVAL_STORAGE_S3_SECRET_KEY"),
    forcePathStyle: requiredEnv("PDF_APPROVAL_STORAGE_S3_FORCE_PATH_STYLE") === "true",
  };
}

function anonymousObjectUrl(storageConfig: S3StorageConfig, key: string): string {
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  return `${storageConfig.endpoint.replace(/\/$/, "")}/${encodeURIComponent(storageConfig.bucket)}/${encodedKey}`;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing integration environment variable: ${name}`);
  }
  return value;
}

function objectKey(): string {
  return createStorageKey("objects/original", uuidv7());
}

function failingReadable(): Readable {
  let emitted = false;
  return new Readable({
    read() {
      if (!emitted) {
        emitted = true;
        this.push(Buffer.from("partial"));
        return;
      }
      this.destroy(new Error("synthetic input failure"));
    },
  });
}

async function consume(body: Readable): Promise<void> {
  for await (const _chunk of body) {
    // Consume until completion or the mapped read error.
  }
}
