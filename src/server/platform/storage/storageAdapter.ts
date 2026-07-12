import type { Readable } from "node:stream";

export type StorageDriver = "filesystem" | "s3";

export interface StorageWriteResult {
  readonly sizeBytes: number;
  readonly sha256: Buffer;
}

export interface StorageHeadResult {
  readonly sizeBytes: number;
}

export interface StorageAdapter {
  readonly driver: StorageDriver;
  write(key: string, body: Readable, contentType: string, options?: { readonly signal?: AbortSignal }): Promise<StorageWriteResult>;
  openRead(key: string): Promise<Readable>;
  head(key: string, options?: { readonly signal?: AbortSignal }): Promise<StorageHeadResult | null>;
  delete(key: string, options?: { readonly signal?: AbortSignal }): Promise<void>;
  checkHealth(): Promise<void>;
}
