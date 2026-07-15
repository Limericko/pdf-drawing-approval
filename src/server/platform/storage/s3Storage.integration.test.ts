import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  it("returns a committed result and reports a sanitized spool cleanup failure", async () => {
    const spoolParent = await mkdtemp(join(tmpdir(), "pdf-approval-s3-spool-test-"));
    const payload = Buffer.from("sensitive committed drawing");
    const diagnostics: unknown[] = [];
    const storage = new S3Storage(
      { ...config, spoolParent },
      {
        async send(command) {
          if (!(command instanceof PutObjectCommand)) {
            throw new Error("Unexpected S3 command");
          }
          await consume(command.input.Body as Readable);
          await writeFile(join(dirname(readStreamPath(command)), "cleanup-blocker"), "block");
          return {};
        },
      },
      {
        reportCleanupFailure(diagnostic) {
          diagnostics.push(diagnostic);
        },
      },
    );
    try {
      await expect(
        storage.write(objectKey(), Readable.from([payload]), "application/pdf"),
      ).resolves.toEqual({
        sizeBytes: payload.byteLength,
        sha256: createHash("sha256").update(payload).digest(),
      });
      expect(diagnostics).toEqual([
        expect.objectContaining({
          code: "SPOOL_CLEANUP_FAILED",
          committed: true,
          dependencyCode: "ENOTEMPTY",
        }),
      ]);
      expect(JSON.stringify(diagnostics)).not.toContain(spoolParent);
      expect(JSON.stringify(diagnostics)).not.toContain(payload.toString());
    } finally {
      storage.destroy();
      await rm(spoolParent, { force: true, recursive: true });
    }
  });

  it("preserves the primary PUT failure when spool cleanup also fails", async () => {
    const spoolParent = await mkdtemp(join(tmpdir(), "pdf-approval-s3-spool-test-"));
    const diagnostics: unknown[] = [];
    const primaryFailure = Object.assign(new Error("synthetic PUT failure"), { code: "ETIMEDOUT" });
    const storage = new S3Storage(
      { ...config, spoolParent },
      {
        async send(command) {
          if (!(command instanceof PutObjectCommand)) {
            throw new Error("Unexpected S3 command");
          }
          await consume(command.input.Body as Readable);
          await writeFile(join(dirname(readStreamPath(command)), "cleanup-blocker"), "block");
          throw primaryFailure;
        },
      },
      {
        reportCleanupFailure(diagnostic) {
          diagnostics.push(diagnostic);
        },
      },
    );
    try {
      await expect(
        storage.write(objectKey(), Readable.from(["candidate"]), "application/pdf"),
      ).rejects.toMatchObject({
        code: "STORAGE_IO_ERROR",
        cause: expect.objectContaining({ code: "ETIMEDOUT" }),
      });
      expect(diagnostics).toEqual([
        expect.objectContaining({
          code: "SPOOL_CLEANUP_FAILED",
          committed: false,
          dependencyCode: "ENOTEMPTY",
        }),
      ]);
    } finally {
      storage.destroy();
      await rm(spoolParent, { force: true, recursive: true });
    }
  });

  it.each(cleanupReporterFailures)(
    "isolates a $name cleanup reporter after a committed write",
    async ({ createReporter }) => {
      const spoolParent = await mkdtemp(join(tmpdir(), "pdf-approval-s3-spool-test-"));
      const payload = "sensitive committed reporter payload";
      const key = objectKey();
      const reporterMessage = "sensitive cleanup reporter failure";
      const fallback = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);
      const reporter = createReporter(reporterMessage);
      const storage = new S3Storage(
        { ...config, spoolParent },
        { async send(command) { return cleanupBlockingSend(command); } },
        { reportCleanupFailure: reporter.report },
      );
      try {
        const outcome = await settle(
          storage.write(key, Readable.from([payload]), "application/pdf"),
        );
        reporter.reject?.();
        await flushAsyncFailures();

        expect(outcome).toMatchObject({ status: "fulfilled" });
        expect(unhandled).toEqual([]);
        expect(fallback).toHaveBeenCalledTimes(1);
        const fallbackOutput = JSON.stringify(fallback.mock.calls);
        for (const sensitive of [reporterMessage, spoolParent, key, payload]) {
          expect(fallbackOutput).not.toContain(sensitive);
        }
      } finally {
        storage.destroy();
        process.off("unhandledRejection", onUnhandled);
        fallback.mockRestore();
        await rm(spoolParent, { force: true, recursive: true });
      }
    },
  );

  it.each(cleanupReporterFailures)(
    "isolates a $name cleanup reporter while preserving the primary failure",
    async ({ createReporter }) => {
      const spoolParent = await mkdtemp(join(tmpdir(), "pdf-approval-s3-spool-test-"));
      const reporterMessage = "sensitive cleanup reporter failure";
      const primaryFailure = Object.assign(new Error("synthetic PUT failure"), {
        code: "ETIMEDOUT",
      });
      const fallback = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);
      const reporter = createReporter(reporterMessage);
      const storage = new S3Storage(
        { ...config, spoolParent },
        { async send(command) { return cleanupBlockingSend(command, primaryFailure); } },
        { reportCleanupFailure: reporter.report },
      );
      try {
        const outcome = await settle(
          storage.write(objectKey(), Readable.from(["candidate"]), "application/pdf"),
        );
        reporter.reject?.();
        await flushAsyncFailures();

        expect(outcome).toMatchObject({
          status: "rejected",
          reason: expect.objectContaining({
            code: "STORAGE_IO_ERROR",
            cause: expect.objectContaining({ code: "ETIMEDOUT" }),
          }),
        });
        expect(unhandled).toEqual([]);
        expect(fallback).toHaveBeenCalledTimes(1);
      } finally {
        storage.destroy();
        process.off("unhandledRejection", onUnhandled);
        fallback.mockRestore();
        await rm(spoolParent, { force: true, recursive: true });
      }
    },
  );

  it.each(["throw", "reject"] as const)(
    "isolates a final fallback console %s",
    async (failureMode) => {
      const spoolParent = await mkdtemp(join(tmpdir(), "pdf-approval-s3-spool-test-"));
      const fallback = vi.spyOn(console, "error").mockImplementation(() => {
        if (failureMode === "throw") {
          throw new Error("fallback throw");
        }
        return Promise.reject(new Error("fallback rejection")) as never;
      });
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);
      const storage = new S3Storage(
        { ...config, spoolParent },
        { async send(command) { return cleanupBlockingSend(command); } },
        { reportCleanupFailure() { throw new Error("reporter failure"); } },
      );
      try {
        const outcome = await settle(
          storage.write(objectKey(), Readable.from(["candidate"]), "application/pdf"),
        );
        await flushAsyncFailures();

        expect(outcome).toMatchObject({ status: "fulfilled" });
        expect(unhandled).toEqual([]);
      } finally {
        storage.destroy();
        process.off("unhandledRejection", onUnhandled);
        fallback.mockRestore();
        await rm(spoolParent, { force: true, recursive: true });
      }
    },
  );

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
      expect(source.listenerCount("error")).toBe(0);
    } finally {
      storage.destroy();
    }
  });

  it("keeps the source error listener until asynchronous destroy completes", async () => {
    const source = new AsyncDestroyFailureReadable();
    const storage = new S3Storage(config, {
      async send() {
        return { Body: source };
      },
    });
    try {
      const output = await storage.openRead(objectKey());
      const outputClosed = eventPromise(output, "close");
      const sourceClosed = eventPromise(source, "close");
      output.destroy();
      await outputClosed;

      const retainedListenerCount = source.listenerCount("error");
      source.once("error", () => undefined);
      await sourceClosed;

      expect(retainedListenerCount).toBeGreaterThan(0);
      expect(source.listenerCount("error")).toBe(0);
    } finally {
      storage.destroy();
    }
  });

  it("removes the mapped error listener after normal object EOF", async () => {
    const source = Readable.from(["complete body"]);
    const storage = new S3Storage(config, {
      async send() {
        return { Body: source };
      },
    });
    try {
      await consume(await storage.openRead(objectKey()));
      expect(source.listenerCount("error")).toBe(0);
    } finally {
      storage.destroy();
    }
  });

  it("aborts a health check whose GetObject body never emits a chunk", async () => {
    const controller = new AbortController();
    let getSignal: AbortSignal | undefined;
    let deleteCalls = 0;
    let destroyCalls = 0;
    const body = new Readable({
      read() {},
      destroy(error, callback) {
        destroyCalls += 1;
        callback(error);
      }
    });
    const storage = new S3Storage(config, {
      async send(command, options) {
        if (command instanceof PutObjectCommand) {
          await consume(command.input.Body as Readable);
          return {};
        }
        if (command instanceof HeadObjectCommand) return { ContentLength: Buffer.byteLength("storage-health") };
        if (command instanceof GetObjectCommand) {
          getSignal = options?.abortSignal;
          return { Body: body };
        }
        if (command instanceof DeleteObjectCommand) {
          deleteCalls += 1;
          return {};
        }
        throw new Error("Unexpected S3 command");
      },
      destroy() {
        body.destroy(new Error("forced test cleanup"));
      }
    });
    const health = storage.checkHealth({ signal: controller.signal });
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      controller.abort();
      const outcome = await Promise.race([
        health.then(() => "RESOLVED", (error: unknown) => error),
        new Promise((resolve) => setTimeout(() => resolve("STILL_PENDING_AFTER_ABORT"), 250))
      ]);

      expect(outcome).not.toBe("STILL_PENDING_AFTER_ABORT");
      expect(outcome).toMatchObject({ code: "STORAGE_HEALTH_CHECK_FAILED" });
      expect(getSignal).toBe(controller.signal);
      expect(destroyCalls).toBe(1);
      expect(deleteCalls).toBe(1);
    } finally {
      storage.destroy();
      await health.catch(() => undefined);
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

  it.each([
    ["HTTP 400", { $metadata: { httpStatusCode: 400 } }],
    ["HTTP 403", { $metadata: { httpStatusCode: 403 } }],
    ["HTTP 404", { $metadata: { httpStatusCode: 404 } }],
    ["DNS ENOTFOUND", { code: "ENOTFOUND", syscall: "getaddrinfo" }],
    ["DNS EAI_AGAIN", { code: "EAI_AGAIN", syscall: "getaddrinfo" }],
    ["connection refused", { code: "ECONNREFUSED", syscall: "connect" }],
    ["TLS connection failure", { code: "ERR_TLS_CERT_ALTNAME_INVALID", syscall: "connect" }],
    ["unknown failure", { name: "UnknownDependencyFailure" }],
  ])("does not mark a pre-commit %s as commit-ambiguous", async (_name, failure) => {
    const storage = new S3Storage(config, failingPutClient(failure));
    try {
      await expect(storage.write(objectKey(), Readable.from("pdf"), "application/pdf"))
        .rejects.toMatchObject({ code: "STORAGE_IO_ERROR", commitAmbiguous: false });
    } finally {
      storage.destroy();
    }
  });

  it.each([
    ["abort", { name: "AbortError" }],
    ["request timeout", { code: "ETIMEDOUT", syscall: "write" }],
    ["connection reset", { code: "ECONNRESET", syscall: "read" }],
    ["broken pipe", { code: "EPIPE", syscall: "write" }],
    ["HTTP 500", { $metadata: { httpStatusCode: 500 } }],
    ["HTTP 503", { $metadata: { httpStatusCode: 503 } }],
    ["no response timeout", { name: "TimeoutError" }],
  ])("marks a post-request %s as commit-ambiguous", async (_name, failure) => {
    const storage = new S3Storage(config, failingPutClient(failure));
    try {
      await expect(storage.write(objectKey(), Readable.from("pdf"), "application/pdf"))
        .rejects.toMatchObject({ code: "STORAGE_IO_ERROR", commitAmbiguous: true });
    } finally {
      storage.destroy();
    }
  });

  it.each([409, 412])("maps HTTP %i conditional PUT conflicts to OBJECT_EXISTS", async (status) => {
    const storage = new S3Storage(config, failingPutClient({ $metadata: { httpStatusCode: status } }));
    try {
      await expect(storage.write(objectKey(), Readable.from("pdf"), "application/pdf"))
        .rejects.toMatchObject({ code: "OBJECT_EXISTS", commitAmbiguous: false });
    } finally {
      storage.destroy();
    }
  });

  it("keeps an explicit HTTP 403 non-ambiguous when the local signal is also aborted", async () => {
    const controller = new AbortController();
    const storage = new S3Storage(config, {
      async send(command) {
        if (!(command instanceof PutObjectCommand)) throw new Error("Unexpected S3 command");
        for await (const _chunk of command.input.Body as Readable) {}
        controller.abort();
        throw Object.assign(new Error("synthetic access denial"), { $metadata: { httpStatusCode: 403 } });
      },
    });
    try {
      await expect(storage.write(objectKey(), Readable.from("pdf"), "application/pdf", { signal: controller.signal }))
        .rejects.toMatchObject({ code: "STORAGE_IO_ERROR", commitAmbiguous: false });
    } finally {
      storage.destroy();
    }
  });

  it("marks a successful PUT followed by local abort as commit-ambiguous", async () => {
    const controller = new AbortController();
    const storage = new S3Storage(config, {
      async send(command) {
        if (!(command instanceof PutObjectCommand)) throw new Error("Unexpected S3 command");
        for await (const _chunk of command.input.Body as Readable) {}
        controller.abort();
        return {};
      },
    });
    try {
      await expect(storage.write(objectKey(), Readable.from("pdf"), "application/pdf", { signal: controller.signal }))
        .rejects.toMatchObject({ code: "STORAGE_IO_ERROR", commitAmbiguous: true });
    } finally {
      storage.destroy();
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

  write(key: string, body: Readable, contentType: string, options?: { readonly signal?: AbortSignal }): Promise<StorageWriteResult> {
    this.keys.add(key);
    return this.storage.write(key, body, contentType, options);
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

function failingPutClient(failure: object) {
  return {
    async send(command: PutObjectCommand) {
      if (!(command instanceof PutObjectCommand)) throw new Error("Unexpected S3 command");
      for await (const _chunk of command.input.Body as Readable) {}
      throw Object.assign(new Error("synthetic PutObject failure"), failure);
    },
  };
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

function readStreamPath(command: PutObjectCommand): string {
  const path = (command.input.Body as Readable & { path?: unknown }).path;
  if (typeof path !== "string") {
    throw new Error("Expected file-backed PutObject body");
  }
  return path;
}

function eventPromise(emitter: Readable, event: "close"): Promise<void> {
  return new Promise((resolveEvent) => emitter.once(event, resolveEvent));
}

class AsyncDestroyFailureReadable extends Readable {
  override _read(): void {}

  override _destroy(_error: Error | null, callback: (error?: Error | null) => void): void {
    setImmediate(() => callback(Object.assign(new Error("async destroy failure"), { code: "EIO" })));
  }
}

const cleanupReporterFailures: ReadonlyArray<{
  name: string;
  createReporter(message: string): {
    report(): void | Promise<void>;
    reject?(): void;
  };
}> = [
  {
    name: "synchronous throwing",
    createReporter: (message) => ({
      report() {
        throw new Error(message);
      },
    }),
  },
  {
    name: "asynchronously rejecting",
    createReporter(message) {
      let reject!: (error: Error) => void;
      const pending = new Promise<void>((_resolve, rejectPending) => {
        reject = rejectPending;
      });
      return {
        report: () => pending,
        reject: () => reject(new Error(message)),
      };
    },
  },
];

async function cleanupBlockingSend(command: unknown, failure?: Error): Promise<object> {
  if (!(command instanceof PutObjectCommand)) {
    throw new Error("Unexpected S3 command");
  }
  await consume(command.input.Body as Readable);
  await writeFile(join(dirname(readStreamPath(command)), "cleanup-blocker"), "block");
  if (failure !== undefined) {
    throw failure;
  }
  return {};
}

async function settle<T>(promise: Promise<T>): Promise<
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown }
> {
  try {
    return { status: "fulfilled", value: await promise };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

async function flushAsyncFailures(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolveFlush) => setImmediate(resolveFlush));
  await new Promise<void>((resolveFlush) => setTimeout(resolveFlush, 0));
  await new Promise<void>((resolveFlush) => setImmediate(resolveFlush));
}
