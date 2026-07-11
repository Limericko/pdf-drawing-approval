import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { VersionedKeyring } from "../config/types.ts";

const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_BYTES = 16;
const HASH_BYTES = 32;
const MAX_GENERATION_ATTEMPTS = 100;
const RECOVERY_DOMAIN = "pdf-approval:recovery-code:v1";
const COMPACT_CODE_PATTERN = /^[0-9A-Fa-f]{32}$/;
const DISPLAY_CODE_PATTERN = /^[0-9A-Fa-f]{4}(?:-[0-9A-Fa-f]{4}){7}$/;
const DUMMY_KEY = Buffer.alloc(HASH_BYTES);

export type RecoveryCodeRandomSource = (size: number) => Buffer;

export type StoredRecoveryCode = {
  keyVersion: string;
  hash: Buffer;
};

export class RecoveryCodeError extends Error {
  readonly code = "RECOVERY_CODE_INVALID";

  constructor() {
    super("RECOVERY_CODE_INVALID");
    this.name = "RecoveryCodeError";
  }
}

const secureRandom: RecoveryCodeRandomSource = (size) => randomBytes(size);

function formatCompactCode(compact: string): string {
  return compact.match(/.{4}/g)?.join("-") ?? "";
}

export function canonicalizeRecoveryCode(code: string): string {
  const compact = DISPLAY_CODE_PATTERN.test(code) ? code.replaceAll("-", "") : code;
  if (!COMPACT_CODE_PATTERN.test(compact)) {
    throw new RecoveryCodeError();
  }
  return formatCompactCode(compact.toUpperCase());
}

export function generateRecoveryCodes(
  randomSource: RecoveryCodeRandomSource = secureRandom
): string[] {
  const codes = new Set<string>();

  for (
    let attempt = 0;
    attempt < MAX_GENERATION_ATTEMPTS && codes.size < RECOVERY_CODE_COUNT;
    attempt += 1
  ) {
    const random = Buffer.from(randomSource(RECOVERY_CODE_BYTES));
    if (random.length !== RECOVERY_CODE_BYTES) {
      throw new RecoveryCodeError();
    }
    codes.add(formatCompactCode(random.toString("hex").toUpperCase()));
  }

  if (codes.size !== RECOVERY_CODE_COUNT) {
    throw new RecoveryCodeError();
  }

  return [...codes];
}

function recoveryCodeHash(code: string, keyVersion: string, key: Buffer): Buffer {
  return createHmac("sha256", key)
    .update(RECOVERY_DOMAIN, "utf8")
    .update("\0", "utf8")
    .update(keyVersion, "utf8")
    .update("\0", "utf8")
    .update(code, "utf8")
    .digest();
}

export function hashRecoveryCode(
  code: string,
  keyring: VersionedKeyring,
  keyVersion = keyring.currentVersion
): StoredRecoveryCode {
  const canonicalCode = canonicalizeRecoveryCode(code);
  const key = keyring.keys.get(keyVersion);
  if (keyVersion.length === 0 || key?.length !== HASH_BYTES) {
    throw new RecoveryCodeError();
  }

  return {
    keyVersion,
    hash: recoveryCodeHash(canonicalCode, keyVersion, key)
  };
}

export function verifyRecoveryCode(
  code: string,
  stored: StoredRecoveryCode,
  keyring: VersionedKeyring
): boolean {
  let canonicalCode: string;
  try {
    canonicalCode = canonicalizeRecoveryCode(code);
  } catch (error) {
    if (error instanceof RecoveryCodeError) {
      return false;
    }
    throw error;
  }

  const configuredKey = keyring.keys.get(stored.keyVersion);
  const keyIsValid = configuredKey?.length === HASH_BYTES;
  const presentedHash = recoveryCodeHash(
    canonicalCode,
    stored.keyVersion,
    keyIsValid ? configuredKey : DUMMY_KEY
  );
  const hashMatches =
    stored.hash.length === HASH_BYTES && timingSafeEqual(presentedHash, stored.hash);

  return Boolean(keyIsValid && hashMatches);
}
