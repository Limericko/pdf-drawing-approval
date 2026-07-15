import type { PlatformStorageConfig } from "../config/types";
import type { StorageAdapter } from "./storageAdapter";
import { FilesystemStorage } from "./filesystemStorage";
import { S3Storage } from "./s3Storage";
import { StorageError } from "./storageErrors";

export function createStorage(config: PlatformStorageConfig): StorageAdapter {
  const runtimeConfig = config as PlatformStorageConfig | null | undefined;
  if (runtimeConfig?.driver === "filesystem") {
    return new FilesystemStorage({ root: runtimeConfig.root });
  }
  if (runtimeConfig?.driver === "s3") {
    return new S3Storage({
      driver: "s3",
      endpoint: runtimeConfig.endpoint,
      region: runtimeConfig.region,
      bucket: runtimeConfig.bucket,
      accessKey: runtimeConfig.accessKey,
      secretKey: runtimeConfig.secretKey,
      forcePathStyle: runtimeConfig.forcePathStyle,
    });
  }
  throw new StorageError("INVALID_STORAGE_DRIVER", "Invalid storage driver");
}
