import { describe, expect, it, vi } from "vitest";
import type { VersionedKeyring } from "../config/types.ts";
import { deriveInvitationToken } from "./tokenHash.ts";
import {
  RecoveryCodeError,
  canonicalizeRecoveryCode,
  generateRecoveryCodes,
  hashRecoveryCode,
  verifyRecoveryCode
} from "./recoveryCodes.ts";

const invitationId = "01890f1e-9b4a-7cc2-8f00-000000000053";
const oldKey = Buffer.alloc(32, 0x13);
const currentKey = Buffer.alloc(32, 0x37);

function keyring(): VersionedKeyring {
  return {
    currentVersion: "v2",
    keys: new Map([
      ["v1", oldKey],
      ["v2", currentKey]
    ])
  };
}

describe("recovery codes", () => {
  it("generates exactly ten unique 128-bit human-readable codes", () => {
    let call = 0;
    const randomSource = vi.fn((size: number) => {
      call += 1;
      return Buffer.alloc(size, call);
    });

    const codes = generateRecoveryCodes(randomSource);

    expect(codes).toHaveLength(10);
    expect(new Set(codes)).toHaveLength(10);
    expect(codes.every((code) => /^[0-9A-F]{4}(?:-[0-9A-F]{4}){7}$/.test(code))).toBe(true);
    expect(randomSource).toHaveBeenCalledTimes(10);
    expect(randomSource.mock.calls.every(([size]) => size === 16)).toBe(true);
  });

  it("uses secure randomness by default", () => {
    const first = generateRecoveryCodes();
    const second = generateRecoveryCodes();

    expect(first).toHaveLength(10);
    expect(second).toHaveLength(10);
    expect(new Set([...first, ...second])).toHaveLength(20);
  });

  it("canonicalizes compact and lowercase display forms", () => {
    const compact = "00112233445566778899aabbccddeeff";

    expect(canonicalizeRecoveryCode(compact)).toBe(
      "0011-2233-4455-6677-8899-AABB-CCDD-EEFF"
    );
    expect(canonicalizeRecoveryCode("0011-2233-4455-6677-8899-aabb-ccdd-eeff")).toBe(
      "0011-2233-4455-6677-8899-AABB-CCDD-EEFF"
    );
  });

  it("hashes a canonical code with the current dedicated key version", () => {
    const code = "0011-2233-4455-6677-8899-AABB-CCDD-EEFF";
    const stored = hashRecoveryCode(code, keyring());

    expect(stored.keyVersion).toBe("v2");
    expect(stored.hash).toHaveLength(32);
    expect(verifyRecoveryCode(code, stored, keyring())).toBe(true);
  });

  it("verifies normalized input and retained old key versions", () => {
    const code = "0011-2233-4455-6677-8899-AABB-CCDD-EEFF";
    const oldStored = hashRecoveryCode(code, keyring(), "v1");

    expect(verifyRecoveryCode(code.toLowerCase(), oldStored, keyring())).toBe(true);
    expect(verifyRecoveryCode(code.replaceAll("-", ""), oldStored, keyring())).toBe(true);
  });

  it("rejects unknown versions, wrong keys, tampered codes, and malformed stored hashes", () => {
    const code = "0011-2233-4455-6677-8899-AABB-CCDD-EEFF";
    const stored = hashRecoveryCode(code, keyring());
    const wrongKeyring: VersionedKeyring = {
      currentVersion: "v2",
      keys: new Map([["v2", Buffer.alloc(32, 0x99)]])
    };

    expect(verifyRecoveryCode(code, { ...stored, keyVersion: "missing" }, keyring())).toBe(false);
    expect(verifyRecoveryCode(code, stored, wrongKeyring)).toBe(false);
    expect(
      verifyRecoveryCode("0011-2233-4455-6677-8899-AABB-CCDD-EE00", stored, keyring())
    ).toBe(false);
    expect(verifyRecoveryCode(code, { ...stored, hash: Buffer.alloc(31) }, keyring())).toBe(false);
    expect(verifyRecoveryCode(code, { ...stored, hash: Buffer.alloc(32) }, keyring())).toBe(false);
  });

  it.each([
    "",
    "0011-2233",
    "00112233445566778899AABBCCDDEEFG",
    "0011 2233 4455 6677 8899 AABB CCDD EEFF",
    "-0011-2233-4455-6677-8899-AABB-CCDD-EEFF"
  ])("rejects an invalid recovery code format: %j", (code) => {
    expect(() => canonicalizeRecoveryCode(code)).toThrowError(RecoveryCodeError);
    expect(verifyRecoveryCode(code, { keyVersion: "v2", hash: Buffer.alloc(32) }, keyring())).toBe(
      false
    );
  });

  it("rejects invalid random output and invalid derivation keys with a stable error", () => {
    const code = "0011-2233-4455-6677-8899-AABB-CCDD-EEFF";
    const missing: VersionedKeyring = { currentVersion: "v3", keys: new Map() };
    const short: VersionedKeyring = {
      currentVersion: "v3",
      keys: new Map([["v3", Buffer.alloc(31)]])
    };

    for (const action of [
      () => generateRecoveryCodes(() => Buffer.alloc(15)),
      () => hashRecoveryCode(code, missing),
      () => hashRecoveryCode(code, short)
    ]) {
      expect(action).toThrowError(RecoveryCodeError);
      try {
        action();
      } catch (error) {
        expect(error).toMatchObject({ code: "RECOVERY_CODE_INVALID" });
      }
    }
  });

  it("domain-separates recovery hashes from invitation tags using the same key material", () => {
    const recoveryCode = canonicalizeRecoveryCode(invitationId.replaceAll("-", ""));
    const recoveryHash = hashRecoveryCode(recoveryCode, keyring(), "v2").hash;
    const invitationTag = Buffer.from(
      deriveInvitationToken(invitationId, "v2", keyring()).split(".")[1] ?? "",
      "base64url"
    );

    expect(recoveryHash).not.toEqual(invitationTag);
  });
});
