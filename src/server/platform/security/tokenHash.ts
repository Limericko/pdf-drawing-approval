import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { VersionedKeyring } from "../config/types.ts";

const DIGEST_BYTES = 32;
const INVITATION_DOMAIN = "pdf-approval:invitation-token:v1";
const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CANONICAL_TAG_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DUMMY_KEY = Buffer.alloc(DIGEST_BYTES);

export type InvitationTokenRecord = {
  invitationId: string;
  keyVersion: string;
  tokenHash: Buffer;
};

export type CreatedInvitationToken = {
  token: string;
  record: InvitationTokenRecord;
};

export class InvalidTokenError extends Error {
  readonly code = "INVALID_TOKEN";

  constructor() {
    super("INVALID_TOKEN");
    this.name = "InvalidTokenError";
  }
}

export class TokenKeyringError extends Error {
  readonly code = "TOKEN_KEYRING_INVALID";

  constructor() {
    super("TOKEN_KEYRING_INVALID");
    this.name = "TokenKeyringError";
  }
}

export function generateOpaqueToken(): string {
  return randomBytes(DIGEST_BYTES).toString("base64url");
}

export function hashOpaqueToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export function verifyOpaqueToken(token: string, storedHash: Buffer): boolean {
  if (storedHash.length !== DIGEST_BYTES) {
    return false;
  }

  return timingSafeEqual(hashOpaqueToken(token), storedHash);
}

function requireDerivationKey(
  invitationId: string,
  keyVersion: string,
  keyring: VersionedKeyring
): Buffer {
  const key = keyring.keys.get(keyVersion);
  if (!CANONICAL_UUID_PATTERN.test(invitationId) || keyVersion.length === 0 || key?.length !== 32) {
    throw new TokenKeyringError();
  }
  return key;
}

function invitationTag(invitationId: string, keyVersion: string, key: Buffer): Buffer {
  return createHmac("sha256", key)
    .update(INVITATION_DOMAIN, "utf8")
    .update("\0", "utf8")
    .update(keyVersion, "utf8")
    .update("\0", "utf8")
    .update(invitationId, "utf8")
    .digest();
}

export function deriveInvitationToken(
  invitationId: string,
  keyVersion: string,
  keyring: VersionedKeyring
): string {
  const key = requireDerivationKey(invitationId, keyVersion, keyring);
  const tag = invitationTag(invitationId, keyVersion, key).toString("base64url");
  return `${invitationId}.${tag}`;
}

export function createInvitationToken(
  invitationId: string,
  keyring: VersionedKeyring
): CreatedInvitationToken {
  const keyVersion = keyring.currentVersion;
  const token = deriveInvitationToken(invitationId, keyVersion, keyring);

  return {
    token,
    record: {
      invitationId,
      keyVersion,
      tokenHash: hashOpaqueToken(token)
    }
  };
}

function parseInvitationToken(token: string): { invitationId: string; tag: Buffer } | undefined {
  const parts = token.split(".");
  if (parts.length !== 2) {
    return undefined;
  }

  const [invitationId, encodedTag] = parts;
  if (
    !invitationId ||
    !encodedTag ||
    !CANONICAL_UUID_PATTERN.test(invitationId) ||
    !CANONICAL_TAG_PATTERN.test(encodedTag)
  ) {
    return undefined;
  }

  const tag = Buffer.from(encodedTag, "base64url");
  if (tag.length !== DIGEST_BYTES || tag.toString("base64url") !== encodedTag) {
    return undefined;
  }

  return { invitationId, tag };
}

export function invitationIdFromToken(token: string): string | undefined {
  return parseInvitationToken(token)?.invitationId;
}

export function verifyInvitationToken(
  token: string,
  stored: InvitationTokenRecord,
  keyring: VersionedKeyring
): true {
  const parsed = parseInvitationToken(token);
  if (!parsed) {
    throw new InvalidTokenError();
  }

  const configuredKey = keyring.keys.get(stored.keyVersion);
  const keyIsValid = configuredKey?.length === DIGEST_BYTES;
  const expectedTag = invitationTag(
    parsed.invitationId,
    stored.keyVersion,
    keyIsValid ? configuredKey : DUMMY_KEY
  );
  const presentedHash = hashOpaqueToken(token);
  const tagMatches = timingSafeEqual(parsed.tag, expectedTag);
  const hashMatches =
    stored.tokenHash.length === DIGEST_BYTES && timingSafeEqual(presentedHash, stored.tokenHash);
  const invitationIdMatches = stored.invitationId === parsed.invitationId;

  if (!keyIsValid || !tagMatches || !hashMatches || !invitationIdMatches) {
    throw new InvalidTokenError();
  }

  return true;
}
