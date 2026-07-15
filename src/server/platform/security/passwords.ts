import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";

const ARGON2ID_ALGORITHM = 2;
const ARGON2_VERSION_19 = 1;
const UINT32_MAX = 0xffff_ffff;
const MAX_PARALLELISM = 0x00ff_ffff;
const MIN_SALT_BYTES = 8;
const MIN_DIGEST_BYTES = 4;

export type Argon2idOptions = {
  memoryCost: number;
  timeCost: number;
  parallelism: number;
  outputLen: number;
};

export class PasswordHashError extends Error {
  readonly code = "INVALID_PASSWORD_HASH";

  constructor() {
    super("INVALID_PASSWORD_HASH");
    this.name = "PasswordHashError";
  }
}

const ARGON2ID_V19_PATTERN =
  /^\$argon2id\$v=19\$m=(0|[1-9]\d*),t=(0|[1-9]\d*),p=(0|[1-9]\d*)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

type ParsedArgon2idPhc = {
  memoryCost: number;
  timeCost: number;
  parallelism: number;
  outputLen: number;
};

function parseUint32(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= UINT32_MAX ? parsed : undefined;
}

function isCanonicalUnpaddedBase64(value: string, minimumBytes: number): boolean {
  const decoded = Buffer.from(value, "base64");
  return (
    decoded.length >= minimumBytes &&
    decoded.toString("base64").replace(/=+$/u, "") === value
  );
}

function parseArgon2idPhc(encoded: string): ParsedArgon2idPhc | undefined {
  const match = ARGON2ID_V19_PATTERN.exec(encoded);
  if (!match) {
    return undefined;
  }

  const [, memoryText, timeText, parallelismText, salt, digest] = match;
  const memoryCost = parseUint32(memoryText);
  const timeCost = parseUint32(timeText);
  const parallelism = parseUint32(parallelismText);
  if (
    memoryCost === undefined ||
    timeCost === undefined ||
    parallelism === undefined ||
    timeCost < 1 ||
    parallelism < 1 ||
    parallelism > MAX_PARALLELISM ||
    memoryCost < 8 * parallelism ||
    !isCanonicalUnpaddedBase64(salt, MIN_SALT_BYTES) ||
    !isCanonicalUnpaddedBase64(digest, MIN_DIGEST_BYTES)
  ) {
    return undefined;
  }

  return { memoryCost, timeCost, parallelism, outputLen: Buffer.from(digest, "base64").length };
}

export function passwordHashMatchesOptions(encoded: string, options: Argon2idOptions): boolean {
  const parsed = parseArgon2idPhc(encoded);
  return Boolean(parsed &&
    parsed.memoryCost === options.memoryCost &&
    parsed.timeCost === options.timeCost &&
    parsed.parallelism === options.parallelism &&
    parsed.outputLen === options.outputLen);
}

export async function hashPassword(password: string, options: Argon2idOptions): Promise<string> {
  return argon2Hash(password, {
    memoryCost: options.memoryCost,
    timeCost: options.timeCost,
    parallelism: options.parallelism,
    outputLen: options.outputLen,
    algorithm: ARGON2ID_ALGORITHM,
    version: ARGON2_VERSION_19
  });
}

export async function verifyPassword(encoded: string, password: string): Promise<boolean> {
  if (!parseArgon2idPhc(encoded)) {
    throw new PasswordHashError();
  }

  try {
    return await argon2Verify(encoded, password);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as Error & { code?: unknown }).code === "InvalidArg"
    ) {
      throw new PasswordHashError();
    }
    throw error;
  }
}
