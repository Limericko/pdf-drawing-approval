import { describe, expect, it } from "vitest";
import { currentTotpFromBase32, currentTotpFromHex } from "./totp.ts";

describe("platform E2E TOTP support", () => {
  it("generates the same code from the seeded hex secret and displayed base32 secret", () => {
    const timeMs = Date.UTC(2026, 6, 13, 10, 0, 0);
    const secretHex = Buffer.from("phase1-e2e-totp-001!", "utf8").toString("hex");
    expect(currentTotpFromHex(secretHex, timeMs)).toMatch(/^\d{6}$/);
    expect(currentTotpFromBase32("OBUGC43FGEWWKMTFFV2G65DQFUYDAMJB", timeMs))
      .toBe(currentTotpFromHex(secretHex, timeMs));
  });

  it("rejects malformed synthetic secrets", () => {
    expect(() => currentTotpFromHex("not-hex")).toThrow("PLATFORM_E2E_TOTP_SECRET_INVALID");
    expect(() => currentTotpFromBase32("***")).toThrow("PLATFORM_E2E_TOTP_SECRET_INVALID");
  });
});
