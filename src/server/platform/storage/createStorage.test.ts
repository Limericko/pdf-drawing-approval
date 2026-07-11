import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PlatformStorageConfig } from "../config/types";
import { FilesystemStorage } from "./filesystemStorage";
import { createStorage } from "./createStorage";
import { S3Storage } from "./s3Storage";

describe("createStorage", () => {
  it("constructs only the filesystem adapter for filesystem config", async () => {
    const root = await mkdtemp(join(tmpdir(), "pdf-approval-storage-factory-"));
    try {
      const config = Object.defineProperty(
        { driver: "filesystem", root },
        "endpoint",
        { get: unexpectedConfigRead },
      ) as PlatformStorageConfig;

      const storage = createStorage(config);

      expect(storage).toBeInstanceOf(FilesystemStorage);
      expect(storage.driver).toBe("filesystem");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("constructs only the S3 adapter without connecting for S3 config", () => {
    const config = Object.defineProperty(
      {
        driver: "s3",
        endpoint: "http://127.0.0.1:1",
        region: "us-east-1",
        bucket: "private-bucket",
        accessKey: "test-access",
        secretKey: "test-secret",
        forcePathStyle: true,
      },
      "root",
      { get: unexpectedConfigRead },
    ) as PlatformStorageConfig;

    const storage = createStorage(config);

    expect(storage).toBeInstanceOf(S3Storage);
    expect(storage.driver).toBe("s3");
    (storage as S3Storage).destroy();
  });

  it.each([undefined, null, {}, { driver: "webdav" }])(
    "rejects an unknown or malformed runtime driver: %j",
    (config) => {
      expect(() => createStorage(config as PlatformStorageConfig)).toThrowError(
        expect.objectContaining({ code: "INVALID_STORAGE_DRIVER" }),
      );
    },
  );
});

function unexpectedConfigRead(): never {
  throw new Error("createStorage read config for the unselected adapter");
}
