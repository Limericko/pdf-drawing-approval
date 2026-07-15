import { prepareInvitationRequestSchema } from "../../../shared/contracts/identity.ts";

type LocationInput = { readonly href: string; readonly origin: string; readonly pathname: string };
type HistoryInput = { replaceState(data: unknown, unused: string, url?: string | URL | null): void };

export type IdentityRoute =
  | { readonly name: "root" }
  | { readonly name: "acceptInvitation"; readonly invitationToken: string }
  | { readonly name: "invalid"; readonly code: string };

type IdentityRouteSnapshot = {
  readonly route: IdentityRoute;
  readonly replacement?: string;
};

export class IdentityRouteCommitError {
  readonly code = "IDENTITY_ROUTE_COMMIT_FAILED" as const;

  constructor() {
    Object.freeze(this);
  }
}

export function createIdentityRouteMemory() {
  let current: IdentityRoute = rootRoute();
  const clear = () => { current = rootRoute(); };
  return Object.freeze({
    read(location: LocationInput, history: HistoryInput, allowedBasePath: string) {
      current = consumeIdentityRoute(location, history, allowedBasePath);
      return current;
    },
    current: () => current,
    cancel: clear,
    complete: clear,
    fail: clear,
    refresh: clear,
    dispose: clear
  });
}

const browserIdentityRoutes = createIdentityRouteMemory();
let browserRouteInitialized = false;

export function initializeBrowserIdentityRoute(location: LocationInput, history: HistoryInput, allowedBasePath: string) {
  if (browserRouteInitialized) return browserIdentityRoutes.current();
  const route = browserIdentityRoutes.read(location, history, allowedBasePath);
  browserRouteInitialized = true;
  return route;
}

export function currentBrowserIdentityRoute() {
  return browserIdentityRoutes.current();
}

export function disposeBrowserIdentityRoute() {
  browserRouteInitialized = false;
  browserIdentityRoutes.dispose();
}

export function consumeIdentityRoute(location: LocationInput, history: HistoryInput, allowedBasePath: string): IdentityRoute {
  const snapshot = parseIdentityRoute(location, allowedBasePath);
  if (snapshot.replacement !== undefined) replaceRouteUrl(history, snapshot.replacement);
  return snapshot.route;
}

function parseIdentityRoute(location: LocationInput, allowedBasePath: string): IdentityRouteSnapshot {
  let url: URL;
  try {
    url = new URL(location.href);
  } catch {
    return { route: invalid("IDENTITY_ROUTE_INVALID") };
  }
  if (url.origin !== location.origin) {
    return { route: invalid("IDENTITY_ROUTE_ORIGIN_INVALID") };
  }

  const fragment = parseFragment(url.hash);
  const basePathname = isCanonicalBasePath(allowedBasePath) && url.pathname === location.pathname &&
      url.pathname === allowedBasePath
    ? url.pathname
    : undefined;
  if (url.search) {
    return { route: invalid("IDENTITY_ROUTE_QUERY_REJECTED"), replacement: basePathname ?? "/" };
  }
  if (!basePathname) {
    return { route: invalid("IDENTITY_ROUTE_PATH_INVALID"),
      ...(containsSensitiveFragment(fragment) ? { replacement: "/" } : {}) };
  }
  const sensitiveFragment = containsSensitiveFragment(fragment);
  if (fragment.path === "" || fragment.path === "/") {
    return { route: rootRoute(), ...(sensitiveFragment ? { replacement: basePathname } : {}) };
  }
  if (fragment.path !== "/accept-invitation") {
    return { route: invalid("IDENTITY_ROUTE_UNSUPPORTED"),
      ...(sensitiveFragment ? { replacement: basePathname } : {}) };
  }

  const tokenValues = fragment.parameters.getAll("token");
  if (tokenValues.length !== 1 || fragment.parameters.size !== 1) {
    return { route: invalid("IDENTITY_INVITATION_TOKEN_INVALID"), replacement: basePathname };
  }
  const parsed = prepareInvitationRequestSchema.safeParse({ invitationToken: tokenValues[0] });
  if (!parsed.success) return { route: invalid("IDENTITY_INVITATION_TOKEN_INVALID"), replacement: basePathname };
  return { route: Object.freeze({ name: "acceptInvitation" as const,
    invitationToken: parsed.data.invitationToken }), replacement: basePathname };
}

function replaceRouteUrl(history: HistoryInput, replacement: string) {
  try {
    history.replaceState(null, "", replacement);
  } catch {
    throw new IdentityRouteCommitError();
  }
}

function parseFragment(hash: string) {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const separator = raw.indexOf("?");
  const path = separator === -1 ? raw : raw.slice(0, separator);
  return { path, parameters: new URLSearchParams(separator === -1 ? "" : raw.slice(separator + 1)) };
}

function containsSensitiveFragment(fragment: ReturnType<typeof parseFragment>) {
  return Array.from(fragment.parameters.keys()).some((key) =>
    /token|secret|challenge|recovery|password|totp|code|uri/i.test(key));
}

function isCanonicalBasePath(value: string) {
  return /^\/(?:[^/?#]+\/)*$/.test(value);
}

function rootRoute(): IdentityRoute {
  return Object.freeze({ name: "root" as const });
}

function invalid(code: string): IdentityRoute {
  return Object.freeze({ name: "invalid" as const, code });
}
