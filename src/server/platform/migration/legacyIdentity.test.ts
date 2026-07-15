import { describe, expect, it } from "vitest";
import { deriveLegacyUuidV7, legacyRowSha256 } from "./legacyIdentity.ts";

describe("legacy migration identity", () => {
  it("derives stable, source-scoped UUIDv7 identifiers", () => {
    const first = deriveLegacyUuidV7("office-server-2026", "user", 42);
    expect(first).toBe(deriveLegacyUuidV7("office-server-2026", "user", "42"));
    expect(first).not.toBe(deriveLegacyUuidV7("office-server-2026", "project", 42));
    expect(first).not.toBe(deriveLegacyUuidV7("other-server-2026", "user", 42));
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("hashes rows independently from object key order", () => {
    expect(legacyRowSha256({ id: 1, nested: { b: 2, a: 1 } }))
      .toBe(legacyRowSha256({ nested: { a: 1, b: 2 }, id: 1 }));
  });

  it("rejects unsafe mapping identities", () => {
    expect(() => deriveLegacyUuidV7("x", "user", 1)).toThrow("LEGACY_IDENTITY_INVALID");
    expect(() => deriveLegacyUuidV7("valid-source", "User", 1)).toThrow("LEGACY_IDENTITY_INVALID");
    expect(() => deriveLegacyUuidV7("valid-source", "user", " bad ")).toThrow("LEGACY_IDENTITY_INVALID");
  });
});
