import { createHash } from "node:crypto";

const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;
const ENTITY_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export function deriveLegacyUuidV7(sourceId: string, entityType: string, legacyId: string | number) {
  assertLegacyIdentity(sourceId, entityType, legacyId);
  const bytes = createHash("sha256")
    .update("pdf-approval-legacy-id-v1\0")
    .update(sourceId)
    .update("\0")
    .update(entityType)
    .update("\0")
    .update(String(legacyId))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function legacyRowSha256(row: Readonly<Record<string, unknown>>) {
  return createHash("sha256").update(stableJson(row)).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right, "en"));
  return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`).join(",")}}`;
}

function assertLegacyIdentity(sourceId: string, entityType: string, legacyId: string | number) {
  const normalizedLegacyId = String(legacyId);
  if (
    !SOURCE_ID_PATTERN.test(sourceId) ||
    !ENTITY_TYPE_PATTERN.test(entityType) ||
    normalizedLegacyId.length < 1 ||
    normalizedLegacyId.length > 240 ||
    normalizedLegacyId !== normalizedLegacyId.trim()
  ) {
    throw new Error("LEGACY_IDENTITY_INVALID");
  }
}
