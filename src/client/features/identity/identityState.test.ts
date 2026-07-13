import { describe, expect, it } from "vitest";
import { initialIdentityState, transitionIdentity } from "./identityState.ts";

const platformUser = {
  id: "01890f1e-9b4a-7cc2-8f00-000000000001",
  emailNormalized: "user@example.test",
  displayName: "Original",
  platformRole: "admin",
  status: "active",
  mfaStatus: "enabled",
  mfaEnabledAt: "2026-07-13T00:00:00.000Z",
  createdAt: "2026-07-13T00:00:00.000Z",
  updatedAt: "2026-07-13T00:00:00.000Z"
} as const;
const signedInSession = { user: platformUser, csrfToken: "must-not-enter-state" };

describe("identityState", () => {
  it("defines the seven required identity states through valid transitions", () => {
    const signedOut = transitionIdentity(initialIdentityState(), { type: "sessionMissing" });
    const challenge = transitionIdentity(signedOut, { type: "loginChallenge", challengeToken: "challenge-secret" });
    const signedIn = transitionIdentity(challenge, { type: "mfaCompleted", session: signedInSession });
    const accepting = transitionIdentity(signedOut, { type: "invitationFound", invitationToken: "invite-secret" });
    const recovery = transitionIdentity(accepting, { type: "invitationCompleted", recoveryCodes: ["code-secret"] });
    const fatal = transitionIdentity(initialIdentityState(), { type: "failed", code: "BOOT_FAILED" });

    expect([initialIdentityState().status, signedOut.status, challenge.status, accepting.status,
      recovery.status, signedIn.status, fatal.status]).toEqual([
      "loading", "signedOut", "mfaChallenge", "acceptingInvitation",
      "showingRecoveryCodes", "signedIn", "fatalError"
    ]);
  });

  it("enriches invitation acceptance only from the invitation state without mutating the prior state", () => {
    const signedOut = transitionIdentity(initialIdentityState(), { type: "sessionMissing" });
    const invitation = transitionIdentity(signedOut, { type: "invitationFound", invitationToken: "invite-secret" });
    const prepared = transitionIdentity(invitation, { type: "invitationPrepared",
      enrollmentToken: "enrollment-secret", otpauthUri: "otpauth://totp/App?secret=totp-secret" });

    expect(invitation).toEqual({ status: "acceptingInvitation", invitationToken: "invite-secret" });
    expect(prepared).toEqual({ status: "acceptingInvitation", invitationToken: "invite-secret",
      enrollmentToken: "enrollment-secret", otpauthUri: "otpauth://totp/App?secret=totp-secret" });
    expect(prepared).not.toBe(invitation);
  });

  it.each(["cancelled", "failed", "loggedOut", "disposed"] as const)(
    "%s clears challenge, invitation, enrollment, TOTP and recovery secrets",
    (eventType) => {
      const sensitiveStates = [
        { status: "mfaChallenge", challengeToken: "challenge-secret" },
        { status: "acceptingInvitation", invitationToken: "invite-secret", enrollmentToken: "enrollment-secret",
          otpauthUri: "otpauth://totp/App?secret=totp-secret" },
        { status: "showingRecoveryCodes", recoveryCodes: ["recovery-secret"] }
      ] as const;
      for (const state of sensitiveStates) {
        const event = eventType === "failed" ? { type: eventType, code: "SAFE_FAILURE" } as const : { type: eventType } as const;
        const cleared = transitionIdentity(state, event);
        expect(JSON.stringify(cleared)).not.toMatch(/challenge-secret|invite-secret|enrollment-secret|totp-secret|recovery-secret/);
      }
    }
  );

  it("keeps recovery codes only in showingRecoveryCodes and removes them after acknowledgement", () => {
    const state = transitionIdentity({ status: "acceptingInvitation", invitationToken: "invite-secret" },
      { type: "invitationCompleted", recoveryCodes: ["one-time-code"] });
    expect(state).toEqual({ status: "showingRecoveryCodes", recoveryCodes: ["one-time-code"] });
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.status === "showingRecoveryCodes" ? state.recoveryCodes : [])).toBe(true);

    const next = transitionIdentity(state, { type: "recoveryCodesAcknowledged" });
    expect(next).toEqual({ status: "signedOut" });
    expect(JSON.stringify(next)).not.toContain("one-time-code");
  });

  it("fails closed with a stable non-secret state for every illegal transition", () => {
    const invalid = transitionIdentity({ status: "signedOut" }, {
      type: "invitationPrepared",
      enrollmentToken: "enrollment-secret",
      otpauthUri: "otpauth://totp/App?secret=totp-secret"
    });
    expect(invalid).toEqual({ status: "fatalError", code: "IDENTITY_STATE_INVALID_TRANSITION" });
    expect(JSON.stringify(invalid)).not.toMatch(/enrollment-secret|totp-secret/);
  });

  it("does not retain CSRF or other session secrets in signed-in UI state", () => {
    const signedIn = transitionIdentity({ status: "mfaChallenge", challengeToken: "challenge-secret" },
      { type: "mfaCompleted", session: signedInSession });
    expect(signedIn).toEqual({ status: "signedIn", user: platformUser });
    expect(JSON.stringify(signedIn)).not.toMatch(/challenge-secret|must-not-enter-state/);
  });

  it("owns an immutable copy of signed-in user data", () => {
    const user = { ...platformUser, displayName: String(platformUser.displayName) };
    const signedIn = transitionIdentity({ status: "mfaChallenge", challengeToken: "challenge-secret" },
      { type: "mfaCompleted", session: { user } });
    user.displayName = "Mutated outside";

    expect(signedIn).toEqual({ status: "signedIn", user: platformUser });
    expect(signedIn.status).toBe("signedIn");
    expect(Object.isFrozen((signedIn as { user: unknown }).user)).toBe(true);
    expect(Object.getPrototypeOf((signedIn as { user: unknown }).user)).toBe(Object.prototype);
  });

  it("rejects unknown nested objects, arrays, functions and secret fields instead of copying them", () => {
    const secret = "nested-secret";
    const untrustedUser = {
      ...platformUser,
      preferences: { secret, projects: ["project-secret"] },
      callback: () => secret
    };
    const next = transitionIdentity({ status: "mfaChallenge", challengeToken: "challenge-secret" }, {
      type: "mfaCompleted",
      session: { user: untrustedUser }
    } as never);

    expect(next).toEqual({ status: "fatalError", code: "IDENTITY_STATE_INVALID_TRANSITION" });
    expect(JSON.stringify(next)).not.toMatch(/nested-secret|project-secret|callback|preferences/);
  });

  it("rejects a caller prototype instead of copying it", () => {
    const prototype = { dangerousMethod: () => "prototype-secret" };
    const prototypedUser = Object.assign(Object.create(prototype) as typeof platformUser, platformUser);
    const next = transitionIdentity({ status: "mfaChallenge", challengeToken: "challenge-secret" }, {
      type: "mfaCompleted",
      session: { user: prototypedUser }
    });

    expect(next).toEqual({ status: "fatalError", code: "IDENTITY_STATE_INVALID_TRANSITION" });
    expect(JSON.stringify(next)).not.toMatch(/dangerousMethod|prototype-secret/);
  });
});
