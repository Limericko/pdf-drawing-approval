import { describe, expect, it, vi } from "vitest";
import {
  createIdentityRouteMemory,
  currentBrowserIdentityRoute,
  disposeBrowserIdentityRoute,
  initializeBrowserIdentityRoute
} from "./identityRoutes.ts";

describe("identityRoutes", () => {
  it("consumes an invitation token from an allowed same-origin fragment and removes it immediately", () => {
    const history = { replaceState: vi.fn() };
    const routes = createIdentityRouteMemory();

    expect(routes.read({
      href: "https://approval.example/#/accept-invitation?token=invitation-secret",
      origin: "https://approval.example",
      pathname: "/"
    }, history, "/")).toEqual({ name: "acceptInvitation", invitationToken: "invitation-secret" });
    expect(history.replaceState).toHaveBeenCalledWith(null, "", "/");
    expect(history.replaceState.mock.calls.flat().join(" ")).not.toContain("invitation-secret");
    expect(routes.current()).toEqual({ name: "acceptInvitation", invitationToken: "invitation-secret" });
  });

  it("rejects and removes query tokens without reading or persisting them", () => {
    const history = { replaceState: vi.fn() };
    const localSet = vi.fn();
    const sessionSet = vi.fn();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("localStorage", { setItem: localSet });
    vi.stubGlobal("sessionStorage", { setItem: sessionSet });
    const routes = createIdentityRouteMemory();

    expect(routes.read({
      href: "https://approval.example/?token=query-secret#/accept-invitation",
      origin: "https://approval.example",
      pathname: "/"
    }, history, "/")).toEqual({ name: "invalid", code: "IDENTITY_ROUTE_QUERY_REJECTED" });
    expect(history.replaceState).toHaveBeenCalledWith(null, "", "/");
    expect(JSON.stringify(routes.current())).not.toContain("query-secret");
    expect(localSet).not.toHaveBeenCalled();
    expect(sessionSet).not.toHaveBeenCalled();
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it.each([
    "https://evil.example/#/accept-invitation?token=secret",
    "https://approval.example/other#/accept-invitation?token=secret",
    "https://approval.example/#/unsupported?token=secret"
  ])("rejects external, unexpected-path or unsupported routes: %s", (href) => {
    const routes = createIdentityRouteMemory();
    const history = { replaceState: vi.fn() };
    const result = routes.read({ href, origin: "https://approval.example", pathname: "/" }, history, "/");
    expect(result.name).toBe("invalid");
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(routes.current())).not.toContain("secret");
  });

  it("rejects /other even when href and pathname agree", () => {
    const result = createIdentityRouteMemory().read({
      href: "https://approval.example/other#/accept-invitation?token=secret",
      origin: "https://approval.example",
      pathname: "/other"
    }, { replaceState: vi.fn() }, "/");
    expect(result).toEqual({ name: "invalid", code: "IDENTITY_ROUTE_PATH_INVALID" });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("accepts the Task16 invitation URL for the supported /app/ deployment base", () => {
    const history = { replaceState: vi.fn() };
    const result = createIdentityRouteMemory().read({
      href: "https://approval.example/app/#/accept-invitation?token=task16-secret",
      origin: "https://approval.example",
      pathname: "/app/"
    }, history, "/app/");
    expect(result).toEqual({ name: "acceptInvitation", invitationToken: "task16-secret" });
    expect(history.replaceState).toHaveBeenCalledWith(null, "", "/app/");
    expect(history.replaceState.mock.calls.flat().join(" ")).not.toContain("task16-secret");
  });

  it("accepts a Task16 invitation URL for an arbitrary configured nested base", () => {
    const history = { replaceState: vi.fn() };
    const result = createIdentityRouteMemory().read({
      href: "https://approval.example/tenant/pdf/#/accept-invitation?token=nested-secret",
      origin: "https://approval.example",
      pathname: "/tenant/pdf/"
    }, history, "/tenant/pdf/");
    expect(result).toEqual({ name: "acceptInvitation", invitationToken: "nested-secret" });
    expect(history.replaceState).toHaveBeenCalledTimes(1);
    expect(history.replaceState).toHaveBeenCalledWith(null, "", "/tenant/pdf/");
  });

  it.each(["token", "recoveryCodes"]) (
    "clears a sensitive root fragment parameter exactly once before returning root: %s",
    (key) => {
      const history = { replaceState: vi.fn() };
      const result = createIdentityRouteMemory().read({
        href: `https://approval.example/#/?${key}=fragment-secret`,
        origin: "https://approval.example",
        pathname: "/"
      }, history, "/");
      expect(result).toEqual({ name: "root" });
      expect(history.replaceState).toHaveBeenCalledTimes(1);
      expect(history.replaceState).toHaveBeenCalledWith(null, "", "/");
      expect(JSON.stringify(result)).not.toContain("fragment-secret");
    }
  );

  it("clears an unsupported fragment code exactly once before rejecting the route", () => {
    const history = { replaceState: vi.fn() };
    const result = createIdentityRouteMemory().read({
      href: "https://approval.example/#/unsupported?code=fragment-secret",
      origin: "https://approval.example",
      pathname: "/"
    }, history, "/");
    expect(result).toEqual({ name: "invalid", code: "IDENTITY_ROUTE_UNSUPPORTED" });
    expect(history.replaceState).toHaveBeenCalledTimes(1);
    expect(history.replaceState).toHaveBeenCalledWith(null, "", "/");
  });

  it.each([
    "token",
    "invitationToken",
    "enrollmentToken",
    "challenge",
    "challengeToken",
    "recovery",
    "recoveryCodes",
    "secret",
    "totpSecret"
  ])("rejects and removes a sensitive outer query key: %s", (key) => {
    const history = { replaceState: vi.fn() };
    const result = createIdentityRouteMemory().read({
      href: `https://approval.example/?${key}=outer-secret#/accept-invitation?token=fragment-secret`,
      origin: "https://approval.example",
      pathname: "/"
    }, history, "/");
    expect(result).toEqual({ name: "invalid", code: "IDENTITY_ROUTE_QUERY_REJECTED" });
    expect(history.replaceState).toHaveBeenCalledWith(null, "", "/");
    expect(history.replaceState.mock.calls.flat().join(" ")).not.toMatch(/outer-secret|fragment-secret/);
  });

  it("rejects any non-standard outer query and clears the URL", () => {
    const history = { replaceState: vi.fn() };
    const result = createIdentityRouteMemory().read({
      href: "https://approval.example/?source=mail#/accept-invitation?token=fragment-secret",
      origin: "https://approval.example",
      pathname: "/"
    }, history, "/");
    expect(result).toEqual({ name: "invalid", code: "IDENTITY_ROUTE_QUERY_REJECTED" });
    expect(history.replaceState).toHaveBeenCalledWith(null, "", "/");
  });

  it("initializes the browser invitation snapshot once until explicit disposal", () => {
    disposeBrowserIdentityRoute();
    const firstHistory = { replaceState: vi.fn() };
    expect(initializeBrowserIdentityRoute({
      href: "https://approval.example/#/accept-invitation?token=invitation-secret",
      origin: "https://approval.example",
      pathname: "/"
    }, firstHistory, "/")).toEqual({ name: "acceptInvitation", invitationToken: "invitation-secret" });
    expect(firstHistory.replaceState).toHaveBeenCalledWith(null, "", "/");

    const secondHistory = { replaceState: vi.fn() };
    expect(initializeBrowserIdentityRoute({
      href: "https://approval.example/",
      origin: "https://approval.example",
      pathname: "/"
    }, secondHistory, "/")).toEqual({ name: "acceptInvitation", invitationToken: "invitation-secret" });
    expect(secondHistory.replaceState).not.toHaveBeenCalled();
    expect(currentBrowserIdentityRoute()).toEqual({ name: "acceptInvitation", invitationToken: "invitation-secret" });

    disposeBrowserIdentityRoute();
    expect(currentBrowserIdentityRoute()).toEqual({ name: "root" });
  });

  it("fails closed without committing route memory when URL replacement throws, then permits one retry", () => {
    disposeBrowserIdentityRoute();
    const secret = "token=replace-state-secret";
    const location = {
      href: `https://approval.example/#/accept-invitation?token=${secret}`,
      origin: "https://approval.example",
      pathname: "/"
    };
    const failedHistory = { replaceState: vi.fn(() => { throw new Error(`password=${secret}`); }) };

    const error = (() => {
      try {
        initializeBrowserIdentityRoute(location, failedHistory, "/");
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toEqual({ code: "IDENTITY_ROUTE_COMMIT_FAILED" });
    expect(Object.keys(error as object)).toEqual(["code"]);
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(secret);
    expect(currentBrowserIdentityRoute()).toEqual({ name: "root" });

    const retryHistory = { replaceState: vi.fn() };
    expect(initializeBrowserIdentityRoute(location, retryHistory, "/"))
      .toEqual({ name: "acceptInvitation", invitationToken: secret });
    expect(retryHistory.replaceState).toHaveBeenCalledTimes(1);
    expect(retryHistory.replaceState).toHaveBeenCalledWith(null, "", "/");

    const laterRootHistory = { replaceState: vi.fn() };
    expect(initializeBrowserIdentityRoute(location, laterRootHistory, "/"))
      .toEqual({ name: "acceptInvitation", invitationToken: secret });
    expect(laterRootHistory.replaceState).not.toHaveBeenCalled();
  });

  it("does not replace the current route snapshot when a later memory read cannot clear its URL", () => {
    const routes = createIdentityRouteMemory();
    routes.read({
      href: "https://approval.example/",
      origin: "https://approval.example",
      pathname: "/"
    }, { replaceState: vi.fn() }, "/");

    expect(() => routes.read({
      href: "https://approval.example/#/accept-invitation?token=uncommitted-secret",
      origin: "https://approval.example",
      pathname: "/"
    }, { replaceState: vi.fn(() => { throw new Error("password=history-secret"); }) }, "/"))
      .toThrow();
    expect(routes.current()).toEqual({ name: "root" });
  });

  it("clears invitation memory on cancel, completion, failure, refresh and disposal", () => {
    for (const clear of ["cancel", "complete", "fail", "refresh", "dispose"] as const) {
      const routes = createIdentityRouteMemory();
      routes.read({
        href: "https://approval.example/#/accept-invitation?token=invitation-secret",
        origin: "https://approval.example",
        pathname: "/"
      }, { replaceState: vi.fn() }, "/");
      routes[clear]();
      expect(routes.current()).toEqual({ name: "root" });
      expect(JSON.stringify(routes.current())).not.toContain("invitation-secret");
    }
  });
});
