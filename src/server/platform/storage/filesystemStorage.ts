import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  realpathSync,
  type Stats,
} from "node:fs";
import {
  link as fsLink,
  lstat,
  mkdir,
  open,
  realpath,
  unlink as fsUnlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { v7 as uuidv7 } from "uuid";
import type {
  StorageAdapter,
  StorageHeadResult,
  StorageWriteResult,
} from "./storageAdapter";
import { StorageError } from "./storageErrors";
import { assertStorageKey, createStorageKey } from "./storageKey";

const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 2_000;
const HEALTH_CONTENT_TYPE = "application/octet-stream";
const HEALTH_PAYLOAD = Buffer.from("storage-health");

export interface FilesystemStorageOptions {
  readonly root: string;
  readonly healthCheckTimeoutMs?: number;
  readonly healthProbeBody?: () => Readable;
  readonly commitOperations?: FilesystemCommitOperations;
}

export interface FilesystemCommitOperations {
  link(existingPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

interface ResolvedStoragePath {
  readonly targetPath: string;
  readonly segments: readonly string[];
}

export class FilesystemStorage implements StorageAdapter {
  readonly driver = "filesystem" as const;

  private readonly root: string;
  private readonly canonicalRoot: string;
  private readonly rootIdentity: Pick<Stats, "dev" | "ino">;
  private readonly healthCheckTimeoutMs: number;
  private readonly healthProbeBody: () => Readable;
  private readonly commitOperations: FilesystemCommitOperations;

  constructor(options: FilesystemStorageOptions) {
    if (!isAbsolute(options.root)) {
      throw new StorageError("INVALID_STORAGE_ROOT", "Storage root must be absolute");
    }
    if (
      options.healthCheckTimeoutMs !== undefined &&
      (!Number.isSafeInteger(options.healthCheckTimeoutMs) || options.healthCheckTimeoutMs <= 0)
    ) {
      throw new StorageError("INVALID_STORAGE_ROOT", "Storage health timeout must be positive");
    }

    this.root = resolve(options.root);
    this.healthCheckTimeoutMs = options.healthCheckTimeoutMs ?? DEFAULT_HEALTH_CHECK_TIMEOUT_MS;
    this.healthProbeBody = options.healthProbeBody ?? (() => Readable.from([HEALTH_PAYLOAD]));
    this.commitOperations = options.commitOperations ?? {
      link: fsLink,
      unlink: fsUnlink,
    };

    try {
      ensureRootExists(this.root);
      const rootStats = lstatSync(this.root);
      if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
        throw unsafeStoragePath();
      }

      this.canonicalRoot = realpathSync.native(this.root);
      if (!pathsEqual(this.root, this.canonicalRoot)) {
        throw unsafeStoragePath();
      }
      this.rootIdentity = { dev: rootStats.dev, ino: rootStats.ino };
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
      throw new StorageError("INVALID_STORAGE_ROOT", "Storage root is unavailable", {
        cause: error,
      });
    }
  }

  async write(
    key: string,
    body: Readable,
    contentType: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<StorageWriteResult> {
    return this.writeInternal(key, body, contentType, options?.signal);
  }

  async openRead(key: string): Promise<Readable> {
    const resolvedPath = this.resolveStoragePath(key);
    try {
      if (!(await this.assertSafeParents(resolvedPath.segments, false))) {
        throw objectNotFound();
      }

      const beforeOpen = await this.inspectFinal(resolvedPath.targetPath);
      if (beforeOpen === null) {
        throw objectNotFound();
      }

      const handle = await open(resolvedPath.targetPath, "r");
      try {
        const openedStats = await handle.stat();
        const afterOpen = await this.inspectFinal(resolvedPath.targetPath);
        await this.assertSafeParents(resolvedPath.segments, false);
        if (
          !openedStats.isFile() ||
          afterOpen === null ||
          !sameFile(beforeOpen, openedStats) ||
          !sameFile(openedStats, afterOpen)
        ) {
          throw unsafeStoragePath();
        }
        return handle.createReadStream({ autoClose: true });
      } catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        throw objectNotFound();
      }
      throw mapStorageOperationError(error);
    }
  }

  async head(key: string, options?: { readonly signal?: AbortSignal }): Promise<StorageHeadResult | null> {
    options?.signal?.throwIfAborted();
    const resolvedPath = this.resolveStoragePath(key);
    try {
      if (!(await this.assertSafeParents(resolvedPath.segments, false))) {
        return null;
      }
      options?.signal?.throwIfAborted();

      const beforeOpen = await this.inspectFinal(resolvedPath.targetPath);
      if (beforeOpen === null) {
        return null;
      }

      const handle = await open(resolvedPath.targetPath, "r");
      try {
        const openedStats = await handle.stat();
        options?.signal?.throwIfAborted();
        const afterOpen = await this.inspectFinal(resolvedPath.targetPath);
        await this.assertSafeParents(resolvedPath.segments, false);
        if (
          !openedStats.isFile() ||
          afterOpen === null ||
          !sameFile(beforeOpen, openedStats) ||
          !sameFile(openedStats, afterOpen)
        ) {
          throw unsafeStoragePath();
        }
        return { sizeBytes: openedStats.size };
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return null;
      }
      throw mapStorageOperationError(error);
    }
  }

  async delete(key: string, options?: { readonly signal?: AbortSignal }): Promise<void> {
    options?.signal?.throwIfAborted();
    const resolvedPath = this.resolveStoragePath(key);
    try {
      if (!(await this.assertSafeParents(resolvedPath.segments, false))) {
        return;
      }
      options?.signal?.throwIfAborted();
      if ((await this.inspectFinal(resolvedPath.targetPath)) === null) {
        return;
      }

      if (!(await this.assertSafeParents(resolvedPath.segments, false))) {
        return;
      }
      if ((await this.inspectFinal(resolvedPath.targetPath)) === null) {
        return;
      }
      options?.signal?.throwIfAborted();
      await fsUnlink(resolvedPath.targetPath);
      options?.signal?.throwIfAborted();
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return;
      }
      throw mapStorageOperationError(error);
    }
  }

  async checkHealth(options?: { readonly signal?: AbortSignal }): Promise<void> {
    const key = createStorageKey("health", uuidv7());
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.healthCheckTimeoutMs);
    timeout.unref();
    const signal = options?.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    let failure: unknown;

    try {
      const writeResult = await this.writeInternal(
        key,
        this.healthProbeBody(),
        HEALTH_CONTENT_TYPE,
        signal,
      );
      signal.throwIfAborted();
      const headResult = await this.head(key, { signal });
      signal.throwIfAborted();
      if (headResult?.sizeBytes !== writeResult.sizeBytes) {
        throw new Error("Health object metadata mismatch");
      }

      const readResult = await readAll(await this.openRead(key), signal);
      if (!readResult.equals(HEALTH_PAYLOAD)) {
        throw new Error("Health object content mismatch");
      }
      signal.throwIfAborted();
    } catch (error) {
      failure = error;
    } finally {
      clearTimeout(timeout);
      try {
        await this.delete(key);
      } catch (cleanupError) {
        failure ??= cleanupError;
      }
    }

    if (failure !== undefined) {
      throw new StorageError("STORAGE_HEALTH_CHECK_FAILED", "Storage health check failed", {
        cause: failure,
      });
    }
  }

  private async writeInternal(
    key: string,
    body: Readable,
    contentType: string,
    signal?: AbortSignal,
  ): Promise<StorageWriteResult> {
    void contentType;
    const resolvedPath = this.resolveStoragePath(key);
    let partialPath: string | undefined;

    try {
      signal?.throwIfAborted();
      await this.assertSafeParents(resolvedPath.segments, true);
      partialPath = join(this.root, `.partial-${randomUUID()}`);

      const hash = createHash("sha256");
      let sizeBytes = 0;
      const meter = new Transform({
        transform(chunk: Buffer | string, encoding, callback) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
          sizeBytes += bytes.byteLength;
          hash.update(bytes);
          callback(null, bytes);
        },
      });
      const output = (await open(partialPath, "wx")).createWriteStream({ autoClose: true });

      if (signal === undefined) {
        await pipeline(body, meter, output);
      } else {
        await pipeline(body, meter, output, { signal });
      }

      signal?.throwIfAborted();
      if (!(await this.assertSafeParents(resolvedPath.segments, false))) {
        throw unsafeStoragePath();
      }
      const existing = await this.inspectFinal(resolvedPath.targetPath);
      if (existing !== null) {
        throw new StorageError("OBJECT_EXISTS", "Storage object already exists");
      }

      try {
        await this.commitOperations.link(partialPath, resolvedPath.targetPath);
      } catch (error) {
        if (isNodeError(error, "EEXIST")) {
          throw new StorageError("OBJECT_EXISTS", "Storage object already exists", { cause: error });
        }
        throw error;
      }

      const publishedPartialPath = partialPath;
      try {
        await this.commitOperations.unlink(publishedPartialPath);
        partialPath = undefined;
      } catch (cleanupError) {
        if (await this.rollbackPublishedObject(publishedPartialPath, resolvedPath.targetPath)) {
          throw cleanupError;
        }
        // The hard link is the commit point. If it cannot be safely rolled back,
        // report success so callers never retry an object that is already published.
      }
      return { sizeBytes, sha256: Buffer.from(hash.digest()) };
    } catch (error) {
      throw mapStorageOperationError(error);
    } finally {
      if (partialPath !== undefined) {
        await this.commitOperations.unlink(partialPath).catch(() => undefined);
      }
    }
  }

  private resolveStoragePath(key: string): ResolvedStoragePath {
    const parsed = assertStorageKey(key);
    const segments = [...parsed.prefix.split("/"), parsed.id];
    const targetPath = resolve(this.root, ...segments);
    const relativePath = relative(this.root, targetPath);
    if (
      relativePath.length === 0 ||
      relativePath === ".." ||
      relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      isAbsolute(relativePath)
    ) {
      throw unsafeStoragePath();
    }
    return { targetPath, segments };
  }

  private async assertSafeParents(
    segments: readonly string[],
    createMissing: boolean,
  ): Promise<boolean> {
    await this.assertRootIdentity();
    let currentPath = this.root;

    for (const segment of segments.slice(0, -1)) {
      currentPath = join(currentPath, segment);
      let stats: Stats;
      try {
        stats = await lstat(currentPath);
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) {
          throw error;
        }
        if (!createMissing) {
          return false;
        }
        try {
          await mkdir(currentPath);
        } catch (mkdirError) {
          if (!isNodeError(mkdirError, "EEXIST")) {
            throw mkdirError;
          }
        }
        stats = await lstat(currentPath);
      }

      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw unsafeStoragePath();
      }
    }

    await this.assertRootIdentity();
    return true;
  }

  private async inspectFinal(targetPath: string): Promise<Stats | null> {
    try {
      const stats = await lstat(targetPath);
      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw unsafeStoragePath();
      }
      return stats;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return null;
      }
      throw error;
    }
  }

  private async assertRootIdentity(): Promise<void> {
    try {
      const stats = await lstat(this.root);
      if (
        stats.isSymbolicLink() ||
        !stats.isDirectory() ||
        stats.dev !== this.rootIdentity.dev ||
        stats.ino !== this.rootIdentity.ino ||
        !pathsEqual(await realpath(this.root), this.canonicalRoot)
      ) {
        throw unsafeStoragePath();
      }
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
      throw unsafeStoragePath(error);
    }
  }

  private async rollbackPublishedObject(
    partialPath: string,
    targetPath: string,
  ): Promise<boolean> {
    let targetStats: Stats;
    try {
      targetStats = await lstat(targetPath);
    } catch (error) {
      return isNodeError(error, "ENOENT");
    }
    if (targetStats.isSymbolicLink() || !targetStats.isFile()) {
      return false;
    }

    let partialStats: Stats;
    try {
      partialStats = await lstat(partialPath);
    } catch {
      return false;
    }
    if (
      partialStats.isSymbolicLink() ||
      !partialStats.isFile() ||
      !sameFile(partialStats, targetStats)
    ) {
      return false;
    }

    try {
      await this.commitOperations.unlink(targetPath);
      return true;
    } catch (error) {
      return isNodeError(error, "ENOENT");
    }
  }
}

function ensureRootExists(root: string): void {
  try {
    lstatSync(root);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      throw error;
    }

    const parent = dirname(root);
    const parentStatsBefore = lstatSync(parent);
    if (parentStatsBefore.isSymbolicLink() || !parentStatsBefore.isDirectory()) {
      throw unsafeStoragePath();
    }
    const canonicalParentBefore = realpathSync.native(parent);
    if (!pathsEqual(parent, canonicalParentBefore)) {
      throw unsafeStoragePath();
    }

    mkdirSync(root);

    const parentStatsAfter = lstatSync(parent);
    const canonicalParentAfter = realpathSync.native(parent);
    if (
      parentStatsAfter.isSymbolicLink() ||
      !parentStatsAfter.isDirectory() ||
      parentStatsAfter.dev !== parentStatsBefore.dev ||
      parentStatsAfter.ino !== parentStatsBefore.ino ||
      !pathsEqual(parent, canonicalParentAfter) ||
      !pathsEqual(canonicalParentBefore, canonicalParentAfter)
    ) {
      throw unsafeStoragePath();
    }
  }
}

function mapStorageOperationError(error: unknown): StorageError {
  if (error instanceof StorageError) {
    return error;
  }
  return new StorageError("STORAGE_IO_ERROR", "Storage operation failed", { cause: error });
}

function objectNotFound(): StorageError {
  return new StorageError("OBJECT_NOT_FOUND", "Storage object was not found");
}

function unsafeStoragePath(cause?: unknown): StorageError {
  return new StorageError("UNSAFE_STORAGE_PATH", "Unsafe storage path", { cause });
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
}

async function readAll(body: Readable, signal: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer | string, encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk, encoding));
      callback();
    },
  });
  await pipeline(body, sink, { signal });
  return Buffer.concat(chunks);
}
