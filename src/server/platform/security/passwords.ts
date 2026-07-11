import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";

const ARGON2ID_ALGORITHM = 2;
const ARGON2_VERSION_19 = 1;

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
  /^\$argon2id\$v=19\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/]{8,}\$[A-Za-z0-9+/]{8,}$/;

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
  if (!ARGON2ID_V19_PATTERN.test(encoded)) {
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
