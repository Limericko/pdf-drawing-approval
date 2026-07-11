import { describe, expect, it, vi } from "vitest";
import type { VersionedKeyring } from "../config/types.ts";
import {
  SecretDecryptionError,
  SecretEncryptionError,
  decryptSecret,
  encryptSecret
} from "./secretEncryption.ts";

const currentKey = Buffer.alloc(32, 0x42);
const oldKey = Buffer.alloc(32, 0x24);

function keyring(): VersionedKeyring {
  return {
    currentVersion: "v2",
    keys: new Map([
      ["v1", oldKey],
      ["v2", currentKey]
    ])
  };
}

function expectDecryptionFailure(action: () => unknown): void {
  expect(action).toThrowError(SecretDecryptionError);
  try {
    action();
  } catch (error) {
    expect(error).toMatchObject({
      code: "SECRET_DECRYPTION_FAILED",
      message: "SECRET_DECRYPTION_FAILED"
    });
  }
}

describe("secret encryption", () => {
  it("round trips a non-empty secret in a versioned AES-256-GCM envelope", () => {
    const plaintext = Buffer.from("totp secret bytes", "utf8");
    const envelope = encryptSecret(plaintext, keyring());

    expect(envelope.keyVersion).toBe("v2");
    expect(envelope.encryptedSecret[0]).toBe(1);
    expect(envelope.encryptedSecret).toHaveLength(1 + 12 + 16 + plaintext.length);
    expect(envelope.encryptedSecret.includes(plaintext)).toBe(false);
    expect(decryptSecret(envelope, keyring())).toEqual(plaintext);
  });

  it("uses a fresh 12-byte nonce for every encryption", () => {
    const plaintext = Buffer.from("same secret", "utf8");
    const first = encryptSecret(plaintext, keyring());
    const second = encryptSecret(plaintext, keyring());

    expect(first.encryptedSecret).not.toEqual(second.encryptedSecret);
    expect(first.encryptedSecret.subarray(1, 13)).not.toEqual(
      second.encryptedSecret.subarray(1, 13)
    );
  });

  it("supports an injected nonce source without weakening the production default", () => {
    const randomSource = vi.fn((size: number) => Buffer.alloc(size, 0x7a));
    const envelope = encryptSecret(Buffer.from("secret"), keyring(), randomSource);

    expect(randomSource).toHaveBeenCalledOnce();
    expect(randomSource).toHaveBeenCalledWith(12);
    expect(envelope.encryptedSecret.subarray(1, 13)).toEqual(Buffer.alloc(12, 0x7a));
    expect(decryptSecret(envelope, keyring())).toEqual(Buffer.from("secret"));
  });

  it("copies caller-owned plaintext and encrypted buffers", () => {
    const plaintext = Buffer.from("copy me", "utf8");
    const envelope = encryptSecret(plaintext, keyring(), (size) => Buffer.alloc(size, 0x31));
    plaintext.fill(0);

    const decrypted = decryptSecret(envelope, keyring());
    expect(decrypted).toEqual(Buffer.from("copy me", "utf8"));
    decrypted.fill(0);
    expect(decryptSecret(envelope, keyring())).toEqual(Buffer.from("copy me", "utf8"));
  });

  it("supports retained old encryption keys", () => {
    const oldOnly: VersionedKeyring = { currentVersion: "v1", keys: new Map([["v1", oldKey]]) };
    const envelope = encryptSecret(Buffer.from("old secret"), oldOnly);

    expect(decryptSecret(envelope, keyring())).toEqual(Buffer.from("old secret"));
  });

  it.each([
    ["format", 0],
    ["nonce", 1],
    ["tag", 13],
    ["ciphertext", 29]
  ])("rejects a tampered %s", (_label, offset) => {
    const envelope = encryptSecret(Buffer.from("secret"), keyring());
    const tampered = Buffer.from(envelope.encryptedSecret);
    tampered[offset] = (tampered[offset] ?? 0) ^ 0xff;

    expectDecryptionFailure(() =>
      decryptSecret({ keyVersion: envelope.keyVersion, encryptedSecret: tampered }, keyring())
    );
  });

  it("rejects a tampered key version, unknown version, and wrong keyring uniformly", () => {
    const envelope = encryptSecret(Buffer.from("secret"), keyring());
    const unknown = { ...envelope, keyVersion: "missing" };
    const wrongVersion = { ...envelope, keyVersion: "v1" };
    const wrongKeyring: VersionedKeyring = {
      currentVersion: "v2",
      keys: new Map([["v2", Buffer.alloc(32, 0x99)]])
    };

    expectDecryptionFailure(() => decryptSecret(unknown, keyring()));
    expectDecryptionFailure(() => decryptSecret(wrongVersion, keyring()));
    expectDecryptionFailure(() => decryptSecret(envelope, wrongKeyring));
  });

  it("strictly rejects malformed and empty encrypted envelopes", () => {
    for (const encryptedSecret of [
      Buffer.alloc(0),
      Buffer.alloc(28),
      Buffer.concat([Buffer.from([1]), Buffer.alloc(12), Buffer.alloc(16)])
    ]) {
      expectDecryptionFailure(() =>
        decryptSecret({ keyVersion: "v2", encryptedSecret }, keyring())
      );
    }
  });

  it("rejects empty plaintext and invalid current encryption keys with a stable operator error", () => {
    const missing: VersionedKeyring = { currentVersion: "v3", keys: new Map() };
    const short: VersionedKeyring = {
      currentVersion: "v3",
      keys: new Map([["v3", Buffer.alloc(31)]])
    };

    for (const action of [
      () => encryptSecret(Buffer.alloc(0), keyring()),
      () => encryptSecret(Buffer.from("secret"), missing),
      () => encryptSecret(Buffer.from("secret"), short),
      () => encryptSecret(Buffer.from("secret"), keyring(), () => Buffer.alloc(11))
    ]) {
      expect(action).toThrowError(SecretEncryptionError);
      try {
        action();
      } catch (error) {
        expect(error).toMatchObject({ code: "SECRET_ENCRYPTION_INVALID" });
      }
    }
  });
});
