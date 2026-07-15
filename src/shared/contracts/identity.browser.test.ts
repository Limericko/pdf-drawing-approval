import { describe, expect, it } from "vitest";

describe("shared identity contracts", () => {
  it("validates UTF-8 byte boundaries without a Node Buffer global", async () => {
    const { completeInvitationRequestSchema, loginRequestSchema } = await import("./identity.ts");
    const originalBuffer = globalThis.Buffer;
    let outcomes: boolean[];
    try {
      globalThis.Buffer = undefined as never;
      outcomes = [
        loginRequestSchema.safeParse({ email: "browser@example.test", password: "界".repeat(85) }).success,
        loginRequestSchema.safeParse({ email: "browser@example.test", password: "界".repeat(86) }).success,
        completeInvitationRequestSchema.safeParse({ enrollmentToken: "token", password: "界".repeat(4),
          totp: "123456" }).success,
        completeInvitationRequestSchema.safeParse({ enrollmentToken: "token", password: "界".repeat(3),
          totp: "123456" }).success
      ];
    } finally {
      globalThis.Buffer = originalBuffer;
    }
    expect(outcomes!).toEqual([true, false, true, false]);
  });
});
