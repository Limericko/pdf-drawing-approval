import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { VersionedKeyring } from "../config/types.ts";

const FORMAT_VERSION = 1;
const FORMAT_BYTES = 1;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32;
const MIN_ENVELOPE_BYTES = FORMAT_BYTES + NONCE_BYTES + AUTH_TAG_BYTES + 1;
const AAD_DOMAIN = "pdf-approval:totp-secret:v1";

export type EncryptedSecretEnvelope = {
  keyVersion: string;
  encryptedSecret: Buffer;
};

export type SecretRandomSource = (size: number) => Buffer;

export class SecretEncryptionError extends Error {
  readonly code = "SECRET_ENCRYPTION_INVALID";

  constructor() {
    super("SECRET_ENCRYPTION_INVALID");
    this.name = "SecretEncryptionError";
  }
}

export class SecretDecryptionError extends Error {
  readonly code = "SECRET_DECRYPTION_FAILED";

  constructor() {
    super("SECRET_DECRYPTION_FAILED");
    this.name = "SecretDecryptionError";
  }
}

function aadFor(keyVersion: string): Buffer {
  return Buffer.concat([
    Buffer.from(AAD_DOMAIN, "utf8"),
    Buffer.from([0, FORMAT_VERSION, 0]),
    Buffer.from(keyVersion, "utf8")
  ]);
}

const secureRandom: SecretRandomSource = (size) => randomBytes(size);

export function encryptSecret(
  secret: Buffer,
  keyring: VersionedKeyring,
  randomSource: SecretRandomSource = secureRandom
): EncryptedSecretEnvelope {
  const keyVersion = keyring.currentVersion;
  const key = keyring.keys.get(keyVersion);
  if (secret.length === 0 || keyVersion.length === 0 || key?.length !== KEY_BYTES) {
    throw new SecretEncryptionError();
  }

  const plaintext = Buffer.from(secret);
  const nonce = Buffer.from(randomSource(NONCE_BYTES));
  if (nonce.length !== NONCE_BYTES) {
    throw new SecretEncryptionError();
  }

  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: AUTH_TAG_BYTES });
  cipher.setAAD(aadFor(keyVersion));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    keyVersion,
    encryptedSecret: Buffer.concat([
      Buffer.from([FORMAT_VERSION]),
      nonce,
      authTag,
      ciphertext
    ])
  };
}

export function decryptSecret(
  envelope: EncryptedSecretEnvelope,
  keyring: VersionedKeyring
): Buffer {
  const encryptedSecret = Buffer.from(envelope.encryptedSecret);
  const key = keyring.keys.get(envelope.keyVersion);
  if (
    envelope.keyVersion.length === 0 ||
    encryptedSecret.length < MIN_ENVELOPE_BYTES ||
    encryptedSecret[0] !== FORMAT_VERSION ||
    key?.length !== KEY_BYTES
  ) {
    throw new SecretDecryptionError();
  }

  const nonceStart = FORMAT_BYTES;
  const tagStart = nonceStart + NONCE_BYTES;
  const ciphertextStart = tagStart + AUTH_TAG_BYTES;
  const nonce = encryptedSecret.subarray(nonceStart, tagStart);
  const authTag = encryptedSecret.subarray(tagStart, ciphertextStart);
  const ciphertext = encryptedSecret.subarray(ciphertextStart);

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, {
      authTagLength: AUTH_TAG_BYTES
    });
    decipher.setAAD(aadFor(envelope.keyVersion));
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new SecretDecryptionError();
  }
}
