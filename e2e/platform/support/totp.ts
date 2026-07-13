import { Secret } from "otpauth";
import { totpAt } from "../../../src/server/platform/security/totp.ts";

const TOTP_SECRET_BYTES = 20;

export function currentTotpFromHex(secretHex: string, timeMs = Date.now()) {
  if (!new RegExp(`^[0-9a-f]{${TOTP_SECRET_BYTES * 2}}$`, "i").test(secretHex)) {
    throw new Error("PLATFORM_E2E_TOTP_SECRET_INVALID");
  }
  return totpAt(Buffer.from(secretHex, "hex"), timeMs);
}

export function currentTotpFromBase32(secretBase32: string, timeMs = Date.now()) {
  if (!/^[A-Z2-7]+$/i.test(secretBase32)) throw new Error("PLATFORM_E2E_TOTP_SECRET_INVALID");
  try {
    const bytes = Buffer.from(Secret.fromBase32(secretBase32).buffer);
    if (bytes.length !== TOTP_SECRET_BYTES) throw new Error("PLATFORM_E2E_TOTP_SECRET_INVALID");
    return totpAt(bytes, timeMs);
  } catch {
    throw new Error("PLATFORM_E2E_TOTP_SECRET_INVALID");
  }
}
