import { createHmac, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import type { VersionedKeyring } from "../config/types.ts";
import { HttpProblem } from "../http/problemResponse.ts";
import type { PlatformAuthLocals } from "./sessionMiddleware.ts";

const VERSION_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const SESSION_ID_PATTERN = /^[0-9a-f-]{36}$/;

export type CsrfProtection = ReturnType<typeof createCsrfProtection>;

export function createCsrfProtection(options: { readonly keyring: VersionedKeyring }) {
  const keyring = options?.keyring;
  if (!keyring || !VERSION_PATTERN.test(keyring.currentVersion) || !keyring.keys.has(keyring.currentVersion)) {
    throw new Error("CSRF_KEYRING_INVALID");
  }
  return Object.freeze({
    issue(sessionId: string) {
      ownSessionId(sessionId);
      return `${keyring.currentVersion}.${mac(keyring.currentVersion, sessionId, keyring.keys.get(keyring.currentVersion)!)}`;
    },
    verify(sessionId: string, token: unknown) {
      if (!SESSION_ID_PATTERN.test(sessionId) || typeof token !== "string" || token.length > 160) return false;
      const separator = token.indexOf(".");
      if (separator <= 0 || token.indexOf(".", separator + 1) !== -1) return false;
      const version = token.slice(0, separator);
      const supplied = token.slice(separator + 1);
      if (!VERSION_PATTERN.test(version) || !/^[A-Za-z0-9_-]+$/.test(supplied)) return false;
      const key = keyring.keys.get(version);
      if (!key) return false;
      const expected = mac(version, sessionId, key);
      const suppliedBuffer = Buffer.from(supplied, "utf8");
      const expectedBuffer = Buffer.from(expected, "utf8");
      return suppliedBuffer.length === expectedBuffer.length && timingSafeEqual(suppliedBuffer, expectedBuffer);
    }
  });
}

export function createCsrfMiddleware(options: { readonly csrf: CsrfProtection }): RequestHandler {
  return (request, response, next) => {
    const auth = (response.locals as PlatformAuthLocals).platformAuth;
    const token = request.get("x-csrf-token");
    if (!auth || !options.csrf.verify(auth.session.id, token)) {
      next(new HttpProblem(403, "CSRF_INVALID", "CSRF validation failed"));
      return;
    }
    next();
  };
}

function mac(version: string, sessionId: string, key: Buffer) {
  return createHmac("sha256", key).update("pdf-approval.csrf\0", "utf8")
    .update(version, "utf8").update("\0", "utf8").update(sessionId, "utf8").digest("base64url");
}

function ownSessionId(value: string) {
  if (!SESSION_ID_PATTERN.test(value)) throw new Error("CSRF_SESSION_ID_INVALID");
}
