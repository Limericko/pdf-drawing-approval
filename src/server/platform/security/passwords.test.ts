import { describe, expect, it } from "vitest";
import {
  hashPassword,
  verifyPassword,
  type Argon2idOptions
} from "./passwords.ts";

const testOptions: Argon2idOptions = {
  memoryCost: 8 * 1024,
  timeCost: 1,
  parallelism: 1,
  outputLen: 32
};

describe("password hashing", () => {
  it("hashes with explicitly supplied Argon2id v19 parameters", async () => {
    const encoded = await hashPassword("correct horse battery staple", testOptions);

    expect(encoded).toMatch(/^\$argon2id\$v=19\$m=8192,t=1,p=1\$/);
  });

  it("verifies the correct password and rejects a wrong password asynchronously", async () => {
    const encoded = await hashPassword("correct password", testOptions);
    const correct = verifyPassword(encoded, "correct password");
    const wrong = verifyPassword(encoded, "wrong password");

    expect(correct).toBeInstanceOf(Promise);
    await expect(correct).resolves.toBe(true);
    await expect(wrong).resolves.toBe(false);
  });

  it("uses a fresh random salt for every hash", async () => {
    const first = await hashPassword("same password", testOptions);
    const second = await hashPassword("same password", testOptions);

    expect(first).not.toBe(second);
    await expect(verifyPassword(first, "same password")).resolves.toBe(true);
    await expect(verifyPassword(second, "same password")).resolves.toBe(true);
  });

  it("does not forward runtime fields outside the narrow options contract", async () => {
    const optionsWithFixedSalt = { ...testOptions, salt: Buffer.alloc(16, 0x55) };

    const first = await hashPassword("same password", optionsWithFixedSalt);
    const second = await hashPassword("same password", optionsWithFixedSalt);

    expect(first).not.toBe(second);
  });

  it.each([
    "",
    "$argon2i$v=19$m=8192,t=1,p=1$c2FsdA$aGFzaA",
    "$argon2id$broken",
    "$argon2id$v=19$m=8192,t=1,p=1$AAAAAAAA$AAAAAAAA",
    "$argon2id$v=19$m=0,t=0,p=0$AAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "$argon2id$v=19$m=08192,t=1,p=1$AAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "$argon2id$v=19$m=8192,t=01,p=1$AAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "$argon2id$v=19$m=8192,t=1,p=01$AAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "$argon2id$v=19$m=4294967296,t=1,p=1$AAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "$argon2id$v=19$m=8192,t=4294967296,p=1$AAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "$argon2id$v=19$m=8192,t=1,p=4294967296$AAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "$argon2id$v=19$m=134217728,t=1,p=16777216$AAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "$argon2id$v=19$m=7,t=1,p=1$AAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "$argon2id$v=19$m=15,t=1,p=2$AAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "$argon2id$v=19$m=8192,t=1,p=1$AAAAAAAAAAB$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "$argon2id$v=19$m=8192,t=1,p=1$AAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB",
    "$argon2id$v=19$m=8192,t=1,p=1$AAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "$argon2id$v=19$m=8192,t=1,p=1$AAAAAAAAAAA$AAAA"
  ])(
    "rejects malformed or unsupported encoded hashes with a stable error: %j",
    async (encoded) => {
      await expect(verifyPassword(encoded, "password")).rejects.toMatchObject({
        code: "INVALID_PASSWORD_HASH"
      });
    }
  );
});
