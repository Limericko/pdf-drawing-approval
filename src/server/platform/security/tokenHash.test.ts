import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { VersionedKeyring } from "../config/types.ts";
import {
  InvalidTokenError,
  TokenKeyringError,
  createInvitationToken,
  deriveInvitationToken,
  generateOpaqueToken,
  hashOpaqueToken,
  verifyInvitationToken,
  verifyOpaqueToken
} from "./tokenHash.ts";

const invitationId = "01890f1e-9b4a-7cc2-8f00-000000000053";
const oldKey = Buffer.alloc(32, 0x11);
const currentKey = Buffer.alloc(32, 0x22);

function keyring(): VersionedKeyring {
  return {
    currentVersion: "v2",
    keys: new Map([
      ["v1", oldKey],
      ["v2", currentKey]
    ])
  };
}

function expectInvalid(action: () => unknown): void {
  expect(action).toThrowError(InvalidTokenError);
  try {
    action();
  } catch (error) {
    expect(error).toMatchObject({ code: "INVALID_TOKEN", message: "INVALID_TOKEN" });
  }
}

describe("opaque tokens", () => {
  it("generates 32 random bytes as canonical unpadded base64url", () => {
    const first = generateOpaqueToken();
    const second = generateOpaqueToken();

    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first).not.toBe(second);
    expect(Buffer.from(first, "base64url")).toHaveLength(32);
  });

  it("stores and verifies only the SHA-256 digest", () => {
    const token = "opaque-secret-value";
    const storedHash = hashOpaqueToken(token);

    expect(storedHash).toEqual(createHash("sha256").update(token, "utf8").digest());
    expect(storedHash).toHaveLength(32);
    expect(verifyOpaqueToken(token, storedHash)).toBe(true);
    expect(verifyOpaqueToken(`${token}-tampered`, storedHash)).toBe(false);
  });

  it("fails closed when a stored digest has the wrong length", () => {
    expect(verifyOpaqueToken("token", Buffer.alloc(31))).toBe(false);
    expect(verifyOpaqueToken("token", Buffer.alloc(33))).toBe(false);
  });
});

describe("invitation tokens", () => {
  it("creates a deterministic token and persistence descriptor using the current key version", () => {
    const created = createInvitationToken(invitationId, keyring());

    expect(created.token).toMatch(
      /^01890f1e-9b4a-7cc2-8f00-000000000053\.[A-Za-z0-9_-]{43}$/
    );
    expect(created.record).toEqual({
      invitationId,
      keyVersion: "v2",
      tokenHash: hashOpaqueToken(created.token)
    });
    expect(deriveInvitationToken(invitationId, "v2", keyring())).toBe(created.token);
  });

  it("verifies current and retained old key versions", () => {
    const current = createInvitationToken(invitationId, keyring());
    const oldToken = deriveInvitationToken(invitationId, "v1", keyring());
    const oldRecord = {
      invitationId,
      keyVersion: "v1",
      tokenHash: hashOpaqueToken(oldToken)
    };

    expect(verifyInvitationToken(current.token, current.record, keyring())).toBe(true);
    expect(verifyInvitationToken(oldToken, oldRecord, keyring())).toBe(true);
  });

  it("uniformly rejects a tampered id, tag, or stored hash", () => {
    const created = createInvitationToken(invitationId, keyring());
    const [id, tag] = created.token.split(".") as [string, string];
    const otherId = "01890f1e-9b4a-7cc2-8f00-000000000054";
    const tamperedTag = `${tag.slice(0, -1)}${tag.endsWith("A") ? "B" : "A"}`;

    expectInvalid(() => verifyInvitationToken(`${otherId}.${tag}`, created.record, keyring()));
    expectInvalid(() => verifyInvitationToken(`${id}.${tamperedTag}`, created.record, keyring()));
    expectInvalid(() =>
      verifyInvitationToken(created.token, { ...created.record, tokenHash: Buffer.alloc(32) }, keyring())
    );
  });

  it("uniformly rejects unknown versions, wrong keys, and removed old versions", () => {
    const created = createInvitationToken(invitationId, keyring());
    const unknownVersion = { ...created.record, keyVersion: "missing" };
    const wrongKeyring: VersionedKeyring = {
      currentVersion: "v2",
      keys: new Map([["v2", Buffer.alloc(32, 0x99)]])
    };
    const oldToken = deriveInvitationToken(invitationId, "v1", keyring());
    const removedOldRecord = {
      invitationId,
      keyVersion: "v1",
      tokenHash: hashOpaqueToken(oldToken)
    };

    expectInvalid(() => verifyInvitationToken(created.token, unknownVersion, keyring()));
    expectInvalid(() => verifyInvitationToken(created.token, created.record, wrongKeyring));
    expectInvalid(() => verifyInvitationToken(oldToken, removedOldRecord, wrongKeyring));
  });

  it("rejects noncanonical ids, token shapes, tags, and base64url encodings", () => {
    const created = createInvitationToken(invitationId, keyring());
    const [id, tag] = created.token.split(".") as [string, string];
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const lastIndex = alphabet.indexOf(tag.at(-1) ?? "");
    const noncanonicalTag = `${tag.slice(0, -1)}${alphabet[lastIndex + 1]}`;

    for (const invalid of [
      `${id.toUpperCase()}.${tag}`,
      `${id}.${tag}=`,
      `${id}.${tag}.extra`,
      `${id}.${tag.slice(1)}`,
      `${id}.${noncanonicalTag}`
    ]) {
      expectInvalid(() => verifyInvitationToken(invalid, created.record, keyring()));
    }
  });

  it("reports a stable operator error when derivation cannot select a valid 32-byte key", () => {
    const missingCurrent: VersionedKeyring = { currentVersion: "v3", keys: new Map() };
    const shortKey: VersionedKeyring = {
      currentVersion: "v3",
      keys: new Map([["v3", Buffer.alloc(31)]])
    };

    for (const invalidKeyring of [missingCurrent, shortKey]) {
      expect(() => createInvitationToken(invitationId, invalidKeyring)).toThrowError(
        TokenKeyringError
      );
      try {
        createInvitationToken(invitationId, invalidKeyring);
      } catch (error) {
        expect(error).toMatchObject({ code: "TOKEN_KEYRING_INVALID" });
      }
    }
  });

  it("rejects noncanonical invitation ids during derivation", () => {
    expect(() => createInvitationToken(invitationId.toUpperCase(), keyring())).toThrowError(
      TokenKeyringError
    );
  });
});
