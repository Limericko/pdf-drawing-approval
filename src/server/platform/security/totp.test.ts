import { describe, expect, it, vi } from "vitest";
import { TOTP } from "otpauth";
import {
  TotpInputError,
  generateTotpSecret,
  totpAt,
  verifyTotp
} from "./totp.ts";

const rfcSecret = Buffer.from("12345678901234567890", "ascii");

describe("TOTP", () => {
  it("generates a fresh 20-byte secret with secure randomness", () => {
    const first = generateTotpSecret();
    const second = generateTotpSecret();

    expect(first).toHaveLength(20);
    expect(second).toHaveLength(20);
    expect(first).not.toEqual(second);
  });

  it("supports a deterministic test random source and copies its buffer", () => {
    const sourceBuffer = Buffer.alloc(20, 0x5a);
    const randomSource = vi.fn(() => sourceBuffer);
    const secret = generateTotpSecret(randomSource);
    sourceBuffer.fill(0);

    expect(randomSource).toHaveBeenCalledOnce();
    expect(randomSource).toHaveBeenCalledWith(20);
    expect(secret).toEqual(Buffer.alloc(20, 0x5a));
  });

  it("matches RFC 6238 SHA-1 at 59 seconds when truncated to 6 digits", () => {
    expect(totpAt(rfcSecret, 59_000)).toBe("287082");
  });

  it("accepts tokens in the previous, current, and next 30-second steps", () => {
    const verificationTime = 90_000;

    expect(verifyTotp(rfcSecret, totpAt(rfcSecret, 60_000), verificationTime)).toBe(true);
    expect(verifyTotp(rfcSecret, totpAt(rfcSecret, 90_000), verificationTime)).toBe(true);
    expect(verifyTotp(rfcSecret, totpAt(rfcSecret, 120_000), verificationTime)).toBe(true);
  });

  it("computes all three window candidates even after finding a match", () => {
    const verificationTime = 90_000;

    for (const tokenTime of [60_000, 90_000, 120_000]) {
      const token = totpAt(rfcSecret, tokenTime);
      const generateSpy = vi.spyOn(TOTP, "generate");

      expect(verifyTotp(rfcSecret, token, verificationTime)).toBe(true);
      expect(generateSpy).toHaveBeenCalledTimes(3);
      generateSpy.mockRestore();
    }
  });

  it("rejects tokens outside the one-step window", () => {
    const verificationTime = 90_000;

    expect(verifyTotp(rfcSecret, totpAt(rfcSecret, 30_000), verificationTime)).toBe(false);
    expect(verifyTotp(rfcSecret, totpAt(rfcSecret, 150_000), verificationTime)).toBe(false);
  });

  it("honors the exact time-step boundary", () => {
    const beforeBoundary = totpAt(rfcSecret, 29_999);

    expect(verifyTotp(rfcSecret, beforeBoundary, 30_000)).toBe(true);
    expect(verifyTotp(rfcSecret, beforeBoundary, 60_000)).toBe(false);
  });

  it.each(["", "12345", "1234567", "12345a", " 123456", "１２３４５６"])(
    "rejects a token that is not exactly six ASCII digits: %j",
    (token) => {
      expect(verifyTotp(rfcSecret, token, 59_000)).toBe(false);
    }
  );

  it("rejects a well-shaped but tampered token", () => {
    expect(verifyTotp(rfcSecret, "287083", 59_000)).toBe(false);
  });

  it.each([1, 19, 21])("rejects a %i-byte secret for generation and verification", (size) => {
    const invalidSecret = Buffer.alloc(size, 0x41);

    expect(() => totpAt(invalidSecret, 59_000)).toThrowError(TotpInputError);
    expect(() => verifyTotp(invalidSecret, "287082", 59_000)).toThrowError(TotpInputError);
  });

  it("rejects empty secrets, invalid timestamps, and wrong-sized generated randomness", () => {
    for (const action of [
      () => totpAt(Buffer.alloc(0), 59_000),
      () => totpAt(rfcSecret, Number.NaN),
      () => totpAt(rfcSecret, -1),
      () => generateTotpSecret(() => Buffer.alloc(19))
    ]) {
      expect(action).toThrowError(TotpInputError);
      try {
        action();
      } catch (error) {
        expect(error).toMatchObject({ code: "TOTP_INPUT_INVALID" });
      }
    }
  });
});
