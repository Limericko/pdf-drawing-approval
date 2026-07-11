import { randomBytes, timingSafeEqual } from "node:crypto";
import { Secret, TOTP } from "otpauth";

const SECRET_BYTES = 20;
const PERIOD_SECONDS = 30;
const PERIOD_MILLISECONDS = PERIOD_SECONDS * 1000;
const TOKEN_DIGITS = 6;
const TOKEN_PATTERN = /^\d{6}$/;

export type TotpRandomSource = (size: number) => Buffer;

export class TotpInputError extends Error {
  readonly code = "TOTP_INPUT_INVALID";

  constructor() {
    super("TOTP_INPUT_INVALID");
    this.name = "TotpInputError";
  }
}

const secureRandom: TotpRandomSource = (size) => randomBytes(size);

function validateSecretAndTime(secret: Buffer, timeMs: number): void {
  if (secret.length !== SECRET_BYTES || !Number.isFinite(timeMs) || timeMs < 0) {
    throw new TotpInputError();
  }
}

function toOtpSecret(secret: Buffer): Secret {
  const copied = Uint8Array.from(secret);
  return new Secret({ buffer: copied.buffer });
}

function tokenForTimestamp(secret: Secret, timestamp: number): string {
  return TOTP.generate({
    secret,
    algorithm: "SHA1",
    digits: TOKEN_DIGITS,
    period: PERIOD_SECONDS,
    timestamp
  });
}

export function generateTotpSecret(randomSource: TotpRandomSource = secureRandom): Buffer {
  const secret = Buffer.from(randomSource(SECRET_BYTES));
  if (secret.length !== SECRET_BYTES) {
    throw new TotpInputError();
  }
  return secret;
}

export function totpAt(secret: Buffer, timeMs: number): string {
  validateSecretAndTime(secret, timeMs);
  return tokenForTimestamp(toOtpSecret(secret), timeMs);
}

export function verifyTotp(secret: Buffer, token: string, timeMs: number): boolean {
  validateSecretAndTime(secret, timeMs);
  if (!TOKEN_PATTERN.test(token)) {
    return false;
  }

  const otpSecret = toOtpSecret(secret);
  const presented = Buffer.from(token, "ascii");
  const currentStep = Math.floor(timeMs / PERIOD_MILLISECONDS);
  let matches = 0;

  for (const offset of [-1, 0, 1]) {
    const candidateStep = currentStep + offset;
    const candidateTimestamp = Math.max(candidateStep, 0) * PERIOD_MILLISECONDS;
    const candidate = Buffer.from(tokenForTimestamp(otpSecret, candidateTimestamp), "ascii");
    const candidateMatches = Number(timingSafeEqual(presented, candidate));
    matches |= candidateMatches & Number(candidateStep >= 0);
  }

  return matches !== 0;
}
