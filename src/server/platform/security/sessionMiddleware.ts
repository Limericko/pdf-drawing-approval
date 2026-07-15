import type { Request, RequestHandler, Response } from "express";
import type { PlatformEnvironment } from "../config/types.ts";
import type { AuthenticatedSession, SessionUser } from "./sessionService.ts";
import { asyncRoute } from "../http/asyncRoute.ts";
import { HttpProblem } from "../http/problemResponse.ts";

export type PlatformAuth = { readonly user: SessionUser; readonly session: AuthenticatedSession };
export type PlatformAuthLocals = { platformAuth?: PlatformAuth };

export type SessionAuthenticator = {
  authenticate(input: { readonly sessionToken: string }): Promise<PlatformAuth>;
};

export type SessionCookieConfig = {
  readonly name: string;
  readonly secure: boolean;
};

export function resolveSessionCookieConfig(input: {
  readonly environment: PlatformEnvironment;
  readonly cookieName: string;
  readonly cookieSecure: boolean;
}): SessionCookieConfig {
  if (input?.environment === "production") {
    if (!input.cookieSecure) throw new Error("INSECURE_PRODUCTION_SESSION_COOKIE");
    return Object.freeze({ name: "__Host-pdf_approval_session", secure: true });
  }
  if (!isSafeCookieName(input?.cookieName) || input.cookieName.startsWith("__Host-")) {
    throw new Error("SESSION_COOKIE_NAME_INVALID");
  }
  return Object.freeze({ name: input.cookieName, secure: Boolean(input.cookieSecure) });
}

export function setSessionCookie(response: Response, config: SessionCookieConfig, sessionToken: string) {
  response.cookie(config.name, sessionToken, { httpOnly: true, secure: config.secure, sameSite: "lax", path: "/" });
}

export function clearSessionCookie(response: Response, config: SessionCookieConfig) {
  response.clearCookie(config.name, { httpOnly: true, secure: config.secure, sameSite: "lax", path: "/" });
}

export function readSessionCookie(request: Pick<Request, "headers">, cookieName: string) {
  return readCookie(request.headers.cookie, cookieName);
}

export function createSessionMiddleware(options: {
  readonly cookieName: string;
  readonly sessions: SessionAuthenticator;
}): RequestHandler {
  if (!isSafeCookieName(options?.cookieName) || !options?.sessions) throw new Error("SESSION_MIDDLEWARE_INVALID");
  return asyncRoute(async (request, response, next) => {
    const token = readCookie(request.headers.cookie, options.cookieName);
    if (token === undefined) {
      next();
      return;
    }
    (response.locals as PlatformAuthLocals).platformAuth = await options.sessions.authenticate({ sessionToken: token });
    next();
  });
}

export const requirePlatformAuth: RequestHandler = (_request, response, next) => {
  if (!(response.locals as PlatformAuthLocals).platformAuth) {
    next(new HttpProblem(401, "AUTHENTICATION_REQUIRED", "Authentication required"));
    return;
  }
  next();
};

function readCookie(header: string | undefined, name: string) {
  if (!header) return undefined;
  let found: string | undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    if (found !== undefined) throw new HttpProblem(401, "SESSION_INVALID", "Authentication required");
    try {
      found = decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      throw new HttpProblem(401, "SESSION_INVALID", "Authentication required");
    }
  }
  if (found === "") throw new HttpProblem(401, "SESSION_INVALID", "Authentication required");
  return found;
}

function isSafeCookieName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/.test(value);
}
