import { StorageError } from "./storageErrors";

const PREFIX_SEGMENT_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const WINDOWS_RESERVED_NAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/;
const CANONICAL_UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface ParsedStorageKey {
  readonly prefix: string;
  readonly id: string;
}

export function createStorageKey(prefix: string, id: string): string {
  assertPrefix(prefix);
  assertUuidV7(id);
  return `${prefix}/${id}`;
}

export function assertStorageKey(key: string): ParsedStorageKey {
  if (typeof key !== "string" || key.length === 0 || key.includes("\\")) {
    throw invalidStorageKey();
  }

  const segments = key.split("/");
  if (segments.length < 2) {
    throw invalidStorageKey();
  }

  const id = segments.at(-1)!;
  const prefix = segments.slice(0, -1).join("/");
  assertPrefix(prefix);
  assertUuidV7(id);
  return { prefix, id };
}

function assertPrefix(prefix: string): void {
  if (typeof prefix !== "string" || prefix.length === 0 || prefix.length > 255) {
    throw invalidStorageKey();
  }

  const segments = prefix.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment.length > 63 ||
        !PREFIX_SEGMENT_PATTERN.test(segment) ||
        WINDOWS_RESERVED_NAME_PATTERN.test(segment),
    )
  ) {
    throw invalidStorageKey();
  }
}

function assertUuidV7(id: string): void {
  if (typeof id !== "string" || !CANONICAL_UUID_V7_PATTERN.test(id)) {
    throw invalidStorageKey();
  }
}

function invalidStorageKey(): StorageError {
  return new StorageError("INVALID_STORAGE_KEY", "Invalid storage key");
}
