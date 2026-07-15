import { platformUserResponseSchema } from "../../../shared/contracts/identity.ts";
import type { z } from "zod";

export type PlatformIdentityUser = z.infer<typeof platformUserResponseSchema>;
type ImmutableIdentityUser = DeepReadonly<PlatformIdentityUser>;

export type IdentityState =
  | { readonly status: "loading" }
  | { readonly status: "signedOut" }
  | { readonly status: "mfaChallenge"; readonly challengeToken: string }
  | { readonly status: "acceptingInvitation"; readonly invitationToken: string;
      readonly enrollmentToken?: string; readonly otpauthUri?: string }
  | { readonly status: "showingRecoveryCodes"; readonly recoveryCodes: readonly string[] }
  | { readonly status: "signedIn"; readonly user: ImmutableIdentityUser }
  | { readonly status: "fatalError"; readonly code: string };

export type IdentityEvent =
  | { readonly type: "sessionLoaded"; readonly session: { readonly user: PlatformIdentityUser } }
  | { readonly type: "sessionMissing" }
  | { readonly type: "loginChallenge"; readonly challengeToken: string }
  | { readonly type: "loginSession"; readonly session: { readonly user: PlatformIdentityUser } }
  | { readonly type: "mfaCompleted"; readonly session: { readonly user: PlatformIdentityUser } }
  | { readonly type: "invitationFound"; readonly invitationToken: string }
  | { readonly type: "invitationPrepared"; readonly enrollmentToken: string; readonly otpauthUri: string }
  | { readonly type: "invitationCompleted"; readonly recoveryCodes: readonly string[] }
  | { readonly type: "recoveryCodesAcknowledged" }
  | { readonly type: "refreshing" }
  | { readonly type: "cancelled" }
  | { readonly type: "failed"; readonly code: string }
  | { readonly type: "loggedOut" }
  | { readonly type: "disposed" };

export function initialIdentityState(): IdentityState {
  return Object.freeze({ status: "loading" as const });
}

export function transitionIdentity(state: IdentityState, event: IdentityEvent): IdentityState {
  if (event.type === "failed") return Object.freeze({ status: "fatalError", code: stableCode(event.code) });
  if (event.type === "loggedOut" || event.type === "disposed" || event.type === "cancelled") return signedOut();

  switch (state.status) {
    case "loading":
      if (event.type === "sessionLoaded") return signedIn(event.session.user);
      if (event.type === "sessionMissing") return signedOut();
      if (event.type === "invitationFound") return acceptingInvitation(event.invitationToken);
      break;
    case "signedOut":
      if (event.type === "loginChallenge") {
        return Object.freeze({ status: "mfaChallenge", challengeToken: event.challengeToken });
      }
      if (event.type === "loginSession") return signedIn(event.session.user);
      if (event.type === "invitationFound") return acceptingInvitation(event.invitationToken);
      if (event.type === "sessionLoaded") return signedIn(event.session.user);
      if (event.type === "refreshing") return initialIdentityState();
      break;
    case "mfaChallenge":
      if (event.type === "mfaCompleted") return signedIn(event.session.user);
      break;
    case "acceptingInvitation":
      if (event.type === "invitationPrepared") {
        return Object.freeze({ status: "acceptingInvitation", invitationToken: state.invitationToken,
          enrollmentToken: event.enrollmentToken, otpauthUri: event.otpauthUri });
      }
      if (event.type === "invitationCompleted") {
        return Object.freeze({ status: "showingRecoveryCodes", recoveryCodes: Object.freeze([...event.recoveryCodes]) });
      }
      break;
    case "showingRecoveryCodes":
      if (event.type === "recoveryCodesAcknowledged") return signedOut();
      break;
    case "signedIn":
      if (event.type === "refreshing") return initialIdentityState();
      break;
    case "fatalError":
      break;
  }
  return invalidTransition();
}

function acceptingInvitation(invitationToken: string): IdentityState {
  return Object.freeze({ status: "acceptingInvitation", invitationToken });
}

function signedIn(user: PlatformIdentityUser): IdentityState {
  const parsed = platformUserResponseSchema.safeParse(user);
  if (!parsed.success) return invalidTransition();
  const ownedUser = deepFreeze(structuredClone(parsed.data));
  return Object.freeze({ status: "signedIn", user: ownedUser });
}

function signedOut(): IdentityState {
  return Object.freeze({ status: "signedOut" });
}

function stableCode(code: string) {
  return /^[A-Z][A-Z0-9_]{1,79}$/.test(code) ? code : "IDENTITY_FAILED";
}

function invalidTransition(): IdentityState {
  return Object.freeze({ status: "fatalError", code: "IDENTITY_STATE_INVALID_TRANSITION" });
}

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}
