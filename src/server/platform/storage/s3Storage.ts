import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { PassThrough, Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { v7 as uuidv7 } from "uuid";
import type { S3StorageConfig } from "../config/types";
import type {
  StorageAdapter,
  StorageHeadResult,
  StorageWriteResult,
} from "./storageAdapter";
import { StorageError } from "./storageErrors";
import { assertStorageKey, createStorageKey } from "./storageKey";

const MAX_SINGLE_PUT_OBJECT_BYTES = 5 * 1024 ** 3 - 1;
const HEALTH_PAYLOAD = Buffer.from("storage-health");
const HEALTH_CONTENT_TYPE = "application/octet-stream";
const SILENT_S3_LOGGER = {
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
};

type S3OperationCommand =
  | PutObjectCommand
  | GetObjectCommand
  | HeadObjectCommand
  | DeleteObjectCommand;

interface S3ClientLike {
  send(command: S3OperationCommand, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
  destroy?(): void;
}

interface S3CleanupFailureDiagnostic {
  readonly code: "SPOOL_CLEANUP_FAILED";
  readonly committed: boolean;
  readonly dependencyCode?: string;
}

interface S3StorageDiagnostics {
  reportCleanupFailure(diagnostic: S3CleanupFailureDiagnostic): void | Promise<void>;
}

const DEFAULT_S3_STORAGE_DIAGNOSTICS: S3StorageDiagnostics = {
  reportCleanupFailure: reportCleanupFallback,
};

export type S3StorageOptions = S3StorageConfig & {
  readonly maxObjectBytes?: number;
  readonly spoolParent?: string;
};

export class S3Storage implements StorageAdapter {
  readonly driver = "s3" as const;

  private readonly bucket: string;
  private readonly client: S3ClientLike;
  private readonly maxObjectBytes: number;
  private readonly spoolParent: string;
  private readonly diagnostics: S3StorageDiagnostics;

  constructor(
    options: S3StorageOptions,
    client?: S3ClientLike,
    diagnostics: S3StorageDiagnostics = DEFAULT_S3_STORAGE_DIAGNOSTICS,
  ) {
    if (
      options.maxObjectBytes !== undefined &&
      (!Number.isSafeInteger(options.maxObjectBytes) ||
        options.maxObjectBytes <= 0 ||
        options.maxObjectBytes > MAX_SINGLE_PUT_OBJECT_BYTES)
    ) {
      throw new StorageError("OBJECT_TOO_LARGE", "Invalid S3 single-PUT object limit");
    }
    if (options.spoolParent !== undefined && !isAbsolute(options.spoolParent)) {
      throw new StorageError("INVALID_STORAGE_ROOT", "S3 spool parent must be absolute");
    }

    this.bucket = options.bucket;
    this.maxObjectBytes = options.maxObjectBytes ?? MAX_SINGLE_PUT_OBJECT_BYTES;
    this.spoolParent = resolve(options.spoolParent ?? tmpdir());
    this.client = client ?? createS3Client(options);
    this.diagnostics = diagnostics;
  }

  async write(key: string, body: Readable, contentType: string): Promise<StorageWriteResult> {
    assertStorageKey(key);
    let spoolDirectory: string;
    try {
      spoolDirectory = await mkdtemp(join(this.spoolParent, "pdf-approval-s3-"));
    } catch (error) {
      throw mapStorageOperationError(error);
    }
    const spoolPath = join(spoolDirectory, "object");
    let spoolHandle: FileHandle | undefined;
    const meter = new HashingSizeTransform(this.maxObjectBytes);
    let result: StorageWriteResult | undefined;
    let primaryError: StorageError | undefined;
    let committed = false;
    try {
      spoolHandle = await open(spoolPath, "wx", 0o600);
      await pipeline(body, meter, spoolHandle.createWriteStream());
      await spoolHandle.close();
      spoolHandle = undefined;

      result = meter.result();
      // MinIO rejects unknown-length transfer-encoding with HTTP 411. Spooling keeps memory
      // bounded while allowing one atomic If-None-Match PUT with an exact Content-Length.
      await this.putSpooledObject(key, spoolPath, result.sizeBytes, contentType);
      committed = true;
    } catch (error) {
      body.destroy();
      primaryError = mapWriteError(error);
    }

    let cleanupError: StorageError | undefined;
    if (spoolHandle !== undefined) {
      try {
        await spoolHandle.close();
      } catch (error) {
        cleanupError = mapStorageOperationError(error);
      }
    }
    try {
      await cleanupSpool(spoolPath, spoolDirectory);
    } catch (error) {
      cleanupError ??= mapStorageOperationError(error);
    }

    if (cleanupError !== undefined) {
      this.reportCleanupFailure(cleanupError, committed);
    }
    if (primaryError !== undefined) {
      throw primaryError;
    }
    if (result === undefined) {
      throw new StorageError("STORAGE_IO_ERROR", "Storage operation failed");
    }
    return result;
  }

  private reportCleanupFailure(error: StorageError, committed: boolean): void {
    const diagnostic: S3CleanupFailureDiagnostic = {
      code: "SPOOL_CLEANUP_FAILED",
      committed,
      dependencyCode: storageDependencyCode(error),
    };
    let reporterResult: void | Promise<void>;
    try {
      reporterResult = this.diagnostics.reportCleanupFailure(diagnostic);
    } catch {
      reportCleanupFallback(diagnostic);
      return;
    }
    if (reporterResult !== undefined) {
      try {
        void Promise.resolve(reporterResult).catch(() => reportCleanupFallback(diagnostic));
      } catch {
        reportCleanupFallback(diagnostic);
      }
    }
  }

  private async putSpooledObject(
    key: string,
    spoolPath: string,
    contentLength: number,
    contentType: string,
  ): Promise<void> {
    const body = createReadStream(spoolPath);
    const abortController = new AbortController();
    const bodyPromise = readableCompletion(body);
    const putPromise = Promise.resolve().then(() =>
      this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentLength: contentLength,
          ContentType: contentType,
          IfNoneMatch: "*",
        }),
        { abortSignal: abortController.signal },
      ),
    );
    try {
      await Promise.all([bodyPromise, putPromise]);
    } catch (error) {
      abortController.abort();
      body.destroy();
      await Promise.allSettled([bodyPromise, putPromise]);
      throw mapWriteError(error);
    }
  }

  async openRead(key: string): Promise<Readable> {
    assertStorageKey(key);
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      const body = responseField(response, "Body");
      return mapReadableErrors(toNodeReadable(body));
    } catch (error) {
      if (isMissingObjectError(error)) {
        throw objectNotFound();
      }
      throw mapStorageOperationError(error);
    }
  }

  async head(key: string): Promise<StorageHeadResult | null> {
    assertStorageKey(key);
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      const sizeBytes = responseField(response, "ContentLength");
      if (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
        throw new StorageError("STORAGE_IO_ERROR", "Storage operation failed");
      }
      return { sizeBytes };
    } catch (error) {
      if (isMissingObjectError(error)) {
        return null;
      }
      throw mapStorageOperationError(error);
    }
  }

  async delete(key: string): Promise<void> {
    assertStorageKey(key);
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      throw mapStorageOperationError(error);
    }
  }

  async checkHealth(): Promise<void> {
    const key = createStorageKey("health", uuidv7());
    let failure: unknown;
    try {
      await this.write(key, Readable.from([HEALTH_PAYLOAD]), HEALTH_CONTENT_TYPE);
      const metadata = await this.head(key);
      if (metadata?.sizeBytes !== HEALTH_PAYLOAD.byteLength) {
        throw new StorageError("STORAGE_IO_ERROR", "Storage health metadata mismatch");
      }
      if (!(await streamEquals(await this.openRead(key), HEALTH_PAYLOAD))) {
        throw new StorageError("STORAGE_IO_ERROR", "Storage health content mismatch");
      }
    } catch (error) {
      failure = error;
    }

    try {
      await this.delete(key);
    } catch (error) {
      failure = error;
    }

    if (failure !== undefined) {
      throw new StorageError("STORAGE_HEALTH_CHECK_FAILED", "Storage health check failed", {
        cause: failure,
      });
    }
  }

  destroy(): void {
    this.client.destroy?.();
  }
}

class HashingSizeTransform extends Transform {
  private readonly hash = createHash("sha256");
  private sizeBytes = 0;

  constructor(private readonly maxObjectBytes: number) {
    super();
  }

  override _transform(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    if (this.sizeBytes + bytes.byteLength > this.maxObjectBytes) {
      callback(new StorageError("OBJECT_TOO_LARGE", "Storage object exceeds the single-PUT limit"));
      return;
    }
    this.sizeBytes += bytes.byteLength;
    this.hash.update(bytes);
    callback(null, bytes);
  }

  result(): StorageWriteResult {
    return {
      sizeBytes: this.sizeBytes,
      sha256: this.hash.digest(),
    };
  }
}

function createS3Client(options: S3StorageOptions): S3ClientLike {
  const client = new S3Client({
    endpoint: options.endpoint,
    region: options.region,
    forcePathStyle: options.forcePathStyle,
    credentials: {
      accessKeyId: options.accessKey,
      secretAccessKey: options.secretKey,
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
    // Dependency diagnostics can contain endpoints or object keys. Callers receive sanitized
    // StorageError values instead of allowing the SDK to write directly to process output.
    logger: SILENT_S3_LOGGER,
  });
  return {
    send(command, sendOptions) {
      return client.send(command, sendOptions);
    },
    destroy() {
      client.destroy();
    },
  };
}

function responseField(response: unknown, field: string): unknown {
  if (typeof response !== "object" || response === null || !(field in response)) {
    return undefined;
  }
  return (response as Record<string, unknown>)[field];
}

function toNodeReadable(body: unknown): Readable {
  if (body instanceof Readable) {
    return body;
  }
  if (isAsyncIterable(body)) {
    return Readable.from(body);
  }
  throw new StorageError("STORAGE_IO_ERROR", "Storage returned an invalid object body");
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function"
  );
}

function mapReadableErrors(source: Readable): Readable {
  const output = new PassThrough();
  const onError = (error: unknown) => output.destroy(mapStorageOperationError(error));
  source.on("error", onError);
  source.once("close", () => source.off("error", onError));
  source.pipe(output);
  output.once("close", () => {
    if (!source.destroyed) {
      source.destroy();
    }
  });
  return output;
}

function mapWriteError(error: unknown): StorageError {
  if (error instanceof StorageError) {
    return error;
  }
  if (isConditionalWriteConflict(error)) {
    return new StorageError("OBJECT_EXISTS", "Storage object already exists", { cause: error });
  }
  return mapStorageOperationError(error);
}

function isConditionalWriteConflict(error: unknown): boolean {
  const name = errorField(error, "name");
  const status = errorHttpStatus(error);
  return name === "PreconditionFailed" || status === 412 || name === "ConditionalRequestConflict";
}

function isMissingObjectError(error: unknown): boolean {
  const name = errorField(error, "name");
  if (
    name === "NoSuchBucket" ||
    errorResponseHeader(error, "x-minio-error-code") === "NoSuchBucket"
  ) {
    return false;
  }
  return errorHttpStatus(error) === 404 || name === "NoSuchKey" || name === "NotFound";
}

function errorResponseHeader(error: unknown, expectedName: string): string | undefined {
  const response = responseField(error, "$response");
  const headers = responseField(response, "headers");
  if (typeof headers !== "object" || headers === null) {
    return undefined;
  }
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== expectedName) {
      continue;
    }
    if (typeof value === "string") {
      return value;
    }
    if (Array.isArray(value) && value.length === 1 && typeof value[0] === "string") {
      return value[0];
    }
    return undefined;
  }
  return undefined;
}

function errorHttpStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("$metadata" in error)) {
    return undefined;
  }
  const metadata = (error as { $metadata?: unknown }).$metadata;
  return typeof metadata === "object" && metadata !== null && "httpStatusCode" in metadata
    ? (metadata as { httpStatusCode?: number }).httpStatusCode
    : undefined;
}

function errorField(error: unknown, field: string): string | undefined {
  if (typeof error !== "object" || error === null || !(field in error)) {
    return undefined;
  }
  const value = (error as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

function mapStorageOperationError(error: unknown): StorageError {
  if (error instanceof StorageError) {
    return error;
  }
  return new StorageError("STORAGE_IO_ERROR", "Storage operation failed", { cause: error });
}

function storageDependencyCode(error: StorageError): string | undefined {
  const cause = error.cause;
  if (typeof cause !== "object" || cause === null || !("code" in cause)) {
    return undefined;
  }
  const code = (cause as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function reportCleanupFallback(diagnostic: S3CleanupFailureDiagnostic): void {
  try {
    const fallbackResult: unknown = console.error("S3 storage spool cleanup failed", diagnostic);
    void Promise.resolve(fallbackResult).catch(() => undefined);
  } catch {
    // Cleanup diagnostics are terminal: they cannot alter the committed or primary operation result.
  }
}

function objectNotFound(): StorageError {
  return new StorageError("OBJECT_NOT_FOUND", "Storage object was not found");
}

function readableCompletion(body: Readable): Promise<void> {
  return new Promise((resolveCompletion, rejectCompletion) => {
    let completed = false;
    body.once("end", () => {
      completed = true;
      resolveCompletion();
    });
    body.once("error", rejectCompletion);
    body.once("close", () => {
      if (!completed) {
        resolveCompletion();
      }
    });
  });
}

async function cleanupSpool(spoolPath: string, spoolDirectory: string): Promise<void> {
  let cleanupError: unknown;
  try {
    await unlink(spoolPath);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) {
      cleanupError = error;
    }
  }
  try {
    await rmdir(spoolDirectory);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) {
      cleanupError ??= error;
    }
  }
  if (cleanupError !== undefined) {
    throw new StorageError("STORAGE_IO_ERROR", "Storage spool cleanup failed", {
      cause: cleanupError,
    });
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

async function streamEquals(body: Readable, expected: Buffer): Promise<boolean> {
  let offset = 0;
  for await (const chunk of body) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (offset + bytes.byteLength > expected.byteLength) {
      return false;
    }
    for (const byte of bytes) {
      if (byte !== expected[offset]) {
        return false;
      }
      offset += 1;
    }
  }
  return offset === expected.byteLength;
}
