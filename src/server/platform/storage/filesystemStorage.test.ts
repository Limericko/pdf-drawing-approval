import { createHash } from "node:crypto";
import {
  link as fsLink,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  unlink as fsUnlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { v7 as uuidv7 } from "uuid";
import { describe, expect, it } from "vitest";
import { FilesystemStorage } from "./filesystemStorage";
import { storageAdapterContract } from "./storageAdapterContract";
import { createStorageKey } from "./storageKey";

storageAdapterContract("filesystem", "filesystem", async () => {
  const root = await mkdtemp(join(tmpdir(), "pdf-approval-storage-contract-"));
  return {
    adapter: new FilesystemStorage({ root, healthCheckTimeoutMs: 500 }),
    cleanup: () => rm(root, { force: true, recursive: true }),
  };
});

describe("FilesystemStorage path safety and cleanup", () => {
  it("requires an absolute storage root", () => {
    expect(isAbsolute("relative-storage-root")).toBe(false);
    expect(() => new FilesystemStorage({ root: "relative-storage-root" })).toThrowError(
      expect.objectContaining({ code: "INVALID_STORAGE_ROOT" }),
    );
  });

  it("does not create a missing root through a symlinked ancestor", async (context) => {
    const safeBase = await mkdtemp(join(tmpdir(), "pdf-approval-storage-safe-base-"));
    const outside = await mkdtemp(join(tmpdir(), "pdf-approval-storage-outside-parent-"));
    const outsideParent = join(outside, "parent");
    const outsideLeaf = join(outsideParent, "storage-root");
    try {
      await mkdir(outsideParent);
      if (!(await tryCreateSymlink(outside, join(safeBase, "link"), "junction"))) {
        context.skip("Platform policy does not permit directory symlink/junction creation");
        return;
      }

      const root = join(safeBase, "link", "parent", "storage-root");
      expect(() => new FilesystemStorage({ root })).toThrowError(
        expect.objectContaining({ code: "UNSAFE_STORAGE_PATH" }),
      );
      await expect(lstat(outsideLeaf)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(safeBase, { force: true, recursive: true });
      await rm(outside, { force: true, recursive: true });
    }
  });

  it("removes partial files after an input stream failure", async () => {
    await withStorage(async ({ root, storage }) => {
      const key = objectKey();

      await expect(storage.write(key, failingReadable(), "application/pdf")).rejects.toMatchObject({
        code: "STORAGE_IO_ERROR",
      });

      expect((await listFiles(root)).filter((path) => path.includes(".partial-"))).toEqual([]);
      await expect(storage.head(key)).resolves.toBeNull();
    });
  });

  it("preserves a sanitized cause without exposing storage paths or stream content", async () => {
    await withStorage(async ({ root, storage }) => {
      const sensitiveValue = `${root}:untrusted-pdf-bytes`;
      let thrown: unknown;
      try {
        await storage.write(
          objectKey(),
          failingReadable(sensitiveValue),
          "application/pdf",
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toMatchObject({
        code: "STORAGE_IO_ERROR",
        cause: expect.any(Error),
      });
      expect(String(thrown)).not.toContain(sensitiveValue);
      expect(String((thrown as Error & { cause: unknown }).cause)).not.toContain(sensitiveValue);
      expect(String((thrown as Error & { cause: unknown }).cause)).not.toContain(root);
    });
  });

  it("rolls back the published object before reporting a partial cleanup failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "pdf-approval-storage-cleanup-"));
    let failedFirstPartialUnlink = false;
    try {
      const storage = new FilesystemStorage({
        root,
        commitOperations: {
          link: fsLink,
          async unlink(path) {
            if (!failedFirstPartialUnlink && path.includes(".partial-")) {
              failedFirstPartialUnlink = true;
              const error = new Error("synthetic partial cleanup failure") as NodeJS.ErrnoException;
              error.code = "EACCES";
              throw error;
            }
            await fsUnlink(path);
          },
        },
      });
      const key = objectKey();

      await expect(storage.write(key, Readable.from(["payload"]), "application/pdf")).rejects.toMatchObject({
        code: "STORAGE_IO_ERROR",
      });

      expect(failedFirstPartialUnlink).toBe(true);
      await expect(storage.head(key)).resolves.toBeNull();
      expect(await listFiles(root)).toEqual([]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("reports success when partial cleanup completed before reporting an error", async () => {
    const root = await mkdtemp(join(tmpdir(), "pdf-approval-storage-cleanup-completed-"));
    let removedPartialBeforeError = false;
    try {
      const storage = new FilesystemStorage({
        root,
        commitOperations: {
          link: fsLink,
          async unlink(path) {
            if (!removedPartialBeforeError && path.includes(".partial-")) {
              removedPartialBeforeError = true;
              await fsUnlink(path);
              const error = new Error("synthetic post-cleanup failure") as NodeJS.ErrnoException;
              error.code = "EACCES";
              throw error;
            }
            await fsUnlink(path);
          },
        },
      });
      const key = objectKey();
      const body = Buffer.from("committed payload");

      await expect(
        storage.write(key, Readable.from([body]), "application/pdf"),
      ).resolves.toEqual({
        sizeBytes: body.byteLength,
        sha256: createHash("sha256").update(body).digest(),
      });

      expect(removedPartialBeforeError).toBe(true);
      expect(await readStream(await storage.openRead(key))).toEqual(body);
      expect((await listFiles(root)).filter((path) => path.includes(".partial-"))).toEqual([]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("leaves no probe object or partial file after a health check", async () => {
    await withStorage(async ({ root, storage }) => {
      await storage.checkHealth();

      expect(await listFiles(root)).toEqual([]);
    });
  });

  it("aborts a stalled health write and waits for cleanup before rejecting", async () => {
    const root = await mkdtemp(join(tmpdir(), "pdf-approval-storage-health-timeout-"));
    let body: Readable | undefined;
    try {
      const storage = new FilesystemStorage({
        root,
        healthCheckTimeoutMs: 20,
        healthProbeBody() {
          let emitted = false;
          body = new Readable({
            read() {
              if (!emitted) {
                emitted = true;
                this.push(Buffer.from("stalled probe"));
              }
            },
          });
          return body;
        },
      });

      await expect(storage.checkHealth()).rejects.toMatchObject({
        code: "STORAGE_HEALTH_CHECK_FAILED",
      });

      expect(body?.destroyed).toBe(true);
      expect(await listFiles(root)).toEqual([]);
    } finally {
      body?.destroy();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects an intermediate directory symlink for every object operation", async (context) => {
    const root = await mkdtemp(join(tmpdir(), "pdf-approval-storage-root-"));
    const outside = await mkdtemp(join(tmpdir(), "pdf-approval-storage-outside-"));
    try {
      const storage = new FilesystemStorage({ root });
      const key = objectKey();
      const id = key.split("/").at(-1)!;
      await mkdir(join(outside, "original"), { recursive: true });
      const outsideTarget = join(outside, "original", id);
      await writeFile(outsideTarget, "outside bytes");

      if (!(await tryCreateSymlink(outside, join(root, "objects"), "junction"))) {
        context.skip("Windows policy does not permit directory symlink/junction creation");
        return;
      }

      await expect(storage.write(key, Readable.from(["new"]), "application/pdf")).rejects.toMatchObject({
        code: "UNSAFE_STORAGE_PATH",
      });
      await expect(storage.openRead(key)).rejects.toMatchObject({ code: "UNSAFE_STORAGE_PATH" });
      await expect(storage.head(key)).rejects.toMatchObject({ code: "UNSAFE_STORAGE_PATH" });
      await expect(storage.delete(key)).rejects.toMatchObject({ code: "UNSAFE_STORAGE_PATH" });
      expect(await readFile(outsideTarget, "utf8")).toBe("outside bytes");
    } finally {
      await rm(root, { force: true, recursive: true });
      await rm(outside, { force: true, recursive: true });
    }
  });

  it("rejects a final object symlink for every object operation", async (context) => {
    const root = await mkdtemp(join(tmpdir(), "pdf-approval-storage-root-"));
    const outside = await mkdtemp(join(tmpdir(), "pdf-approval-storage-outside-"));
    try {
      const storage = new FilesystemStorage({ root });
      const key = objectKey();
      const finalPath = join(root, ...key.split("/"));
      const outsideTarget = join(outside, "outside-object");
      await mkdir(join(root, "objects", "original"), { recursive: true });
      await writeFile(outsideTarget, "outside bytes");

      if (!(await tryCreateSymlink(outsideTarget, finalPath, "file"))) {
        context.skip("Windows policy does not permit file symlink creation");
        return;
      }

      await expect(storage.write(key, Readable.from(["new"]), "application/pdf")).rejects.toMatchObject({
        code: "UNSAFE_STORAGE_PATH",
      });
      await expect(storage.openRead(key)).rejects.toMatchObject({ code: "UNSAFE_STORAGE_PATH" });
      await expect(storage.head(key)).rejects.toMatchObject({ code: "UNSAFE_STORAGE_PATH" });
      await expect(storage.delete(key)).rejects.toMatchObject({ code: "UNSAFE_STORAGE_PATH" });
      expect(await readFile(outsideTarget, "utf8")).toBe("outside bytes");
    } finally {
      await rm(root, { force: true, recursive: true });
      await rm(outside, { force: true, recursive: true });
    }
  });

  it("fails closed when the final path is not a regular file", async () => {
    await withStorage(async ({ root, storage }) => {
      const key = objectKey();
      await mkdir(join(root, ...key.split("/")), { recursive: true });

      await expect(storage.write(key, Readable.from(["new"]), "application/pdf")).rejects.toMatchObject({
        code: "UNSAFE_STORAGE_PATH",
      });
      await expect(storage.openRead(key)).rejects.toMatchObject({ code: "UNSAFE_STORAGE_PATH" });
      await expect(storage.head(key)).rejects.toMatchObject({ code: "UNSAFE_STORAGE_PATH" });
      await expect(storage.delete(key)).rejects.toMatchObject({ code: "UNSAFE_STORAGE_PATH" });
    });
  });
});

async function withStorage(
  run: (fixture: { root: string; storage: FilesystemStorage }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pdf-approval-storage-"));
  try {
    await run({ root, storage: new FilesystemStorage({ root, healthCheckTimeoutMs: 500 }) });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

function objectKey(): string {
  return createStorageKey("objects/original", uuidv7());
}

function failingReadable(message = "synthetic stream failure"): Readable {
  let readCount = 0;
  return new Readable({
    read() {
      if (readCount === 0) {
        readCount += 1;
        this.push(Buffer.from("partial"));
        return;
      }
      this.destroy(new Error(message));
    },
  });
}

async function listFiles(root: string, relative = ""): Promise<string[]> {
  const directory = join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const child = join(relative, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, child)));
    } else {
      files.push(child);
    }
  }
  return files.sort();
}

async function readStream(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function tryCreateSymlink(
  target: string,
  path: string,
  type: "file" | "junction",
): Promise<boolean> {
  try {
    await symlink(target, path, type);
    return true;
  } catch (error) {
    if (
      process.platform === "win32" &&
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "EPERM" || error.code === "EACCES")
    ) {
      return false;
    }
    throw error;
  }
}
