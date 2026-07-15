import { describe, expect, it } from "vitest";
import { assertStorageKey, createStorageKey } from "./storageKey";

const CANONICAL_UUID_V7 = "01890f2e-c960-7cc2-98f1-9b4a44e5a801";

describe("storage keys", () => {
  it("creates a key from a controlled multi-segment prefix and canonical UUIDv7", () => {
    const key = createStorageKey("objects/original", CANONICAL_UUID_V7);

    expect(key).toBe(`objects/original/${CANONICAL_UUID_V7}`);
    expect(assertStorageKey(key)).toEqual({
      prefix: "objects/original",
      id: CANONICAL_UUID_V7,
    });
  });

  it.each([
    "../objects",
    "/objects",
    "objects\\original",
    "objects//original",
    "objects/./original",
    "objects/../original",
    "Objects/original",
    "objects/original.pdf",
    "objects/original file",
    "objects/%2foriginal",
    "objects/%5coriginal",
    "con",
    "objects/nul",
    "objects/com1",
    "objects/lpt9",
    "",
  ])("rejects unsafe or uncontrolled prefix %j", (prefix) => {
    expect(() => createStorageKey(prefix, CANONICAL_UUID_V7)).toThrowError(
      expect.objectContaining({ code: "INVALID_STORAGE_KEY" }),
    );
  });

  it.each([
    "01890F2E-C960-7CC2-98F1-9B4A44E5A801",
    "01890f2e-c960-4cc2-98f1-9b4a44e5a801",
    "01890f2e-c960-7cc2-78f1-9b4a44e5a801",
    "01890f2e-c960-7cc2-f8f1-9b4a44e5a801",
    "01890f2ec9607cc298f19b4a44e5a801",
    "diagram.pdf",
    "",
  ])("rejects non-canonical UUIDv7 identifier %j", (id) => {
    expect(() => createStorageKey("objects/original", id)).toThrowError(
      expect.objectContaining({ code: "INVALID_STORAGE_KEY" }),
    );
  });

  it.each([
    "diagram.pdf",
    "objects/original/diagram.pdf",
    `objects//original/${CANONICAL_UUID_V7}`,
    `objects/./original/${CANONICAL_UUID_V7}`,
    `objects/../original/${CANONICAL_UUID_V7}`,
    `/objects/original/${CANONICAL_UUID_V7}`,
    `objects\\original\\${CANONICAL_UUID_V7}`,
    `objects/original/${CANONICAL_UUID_V7}/`,
    `objects/original/${CANONICAL_UUID_V7.toUpperCase()}`,
    "",
  ])("rejects malformed raw key %j", (key) => {
    expect(() => assertStorageKey(key)).toThrowError(
      expect.objectContaining({ code: "INVALID_STORAGE_KEY" }),
    );
  });
});
