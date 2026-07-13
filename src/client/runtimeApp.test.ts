import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import express from "express";
import request from "supertest";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createPlatformHealthRouter } from "../server/platform/health.ts";
import { buildPublicHealth } from "../server/services/publicHealth.ts";
import {
  RuntimeApp,
  RuntimeEntryView,
  activateRuntimeEntry,
  createRuntimeModeLoader,
  probeRuntimeMode,
  readRuntimeListenerDiagnostics
} from "./RuntimeApp.tsx";
import { currentBrowserIdentityRoute, disposeBrowserIdentityRoute } from "./features/identity/identityRoutes.ts";
import { createProject, disposeIdentityClient, getSession } from "./api/identityClient.ts";

let platformHealth: Record<string, unknown>;
let legacyHealth: Record<string, unknown>;
type TestRuntimeSelection = { readonly mode: "legacy" } | { readonly mode: "platform"; readonly basePath: string };

beforeAll(async () => {
  const app = express();
  app.use(createPlatformHealthRouter({ core: {
    postgres: async () => undefined,
    schema: async () => undefined,
    storage: async () => undefined
  }, basePath: "/nested/app/" } as Parameters<typeof createPlatformHealthRouter>[0]));
  platformHealth = (await request(app).get("/health").expect(200)).body as Record<string, unknown>;
  legacyHealth = buildPublicHealth({ port: 8080, lanAddresses: ["192.168.1.20"],
    startedAt: "2026-07-13T00:00:00.000Z" });
});

describe("RuntimeApp", () => {
  it("renders the existing legacy App immediately for Electron without probing platform health", () => {
    const probe = vi.fn();
    vi.stubGlobal("location", { hash: "" });
    vi.stubGlobal("localStorage", { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() });
    const markup = renderToStaticMarkup(React.createElement(RuntimeApp, { desktopClient: true,
      loader: createRuntimeModeLoader(probe) }));
    expect(markup).toContain("登录");
    expect(probe).not.toHaveBeenCalled();
  });

  it.each(["legacy", "platform"] as const)("strictly accepts the real %s /health response", async (runtimeMode) => {
    const health = runtimeMode === "legacy" ? legacyHealth : platformHealth;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(health), {
      headers: { "Content-Type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(probeRuntimeMode(new AbortController().signal)).resolves.toEqual(runtimeMode === "platform"
      ? { mode: "platform", basePath: "/nested/app/" }
      : { mode: "legacy" });
    expect(fetchMock).toHaveBeenCalledWith("/health", expect.objectContaining({
      cache: "no-store",
      credentials: "same-origin"
    }));
  });

  it.each(["legacy", "platform"] as const)("rejects the real %s /health response with every field missing in turn",
    async (runtimeMode) => {
    const fixture = runtimeMode === "platform" ? platformHealth : legacyHealth;
    for (const missingField of Object.keys(fixture)) {
      const malformed = { ...fixture };
      delete malformed[missingField];
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(malformed), {
        headers: { "Content-Type": "application/json" }
      })));
      await expect(probeRuntimeMode(new AbortController().signal),
        `${runtimeMode}.${missingField}`).rejects.toMatchObject({ code: "RUNTIME_MODE_PROBE_FAILED" });
    }
  });

  it.each(["legacy", "platform"] as const)("rejects extra fields in the real %s /health response", async (runtimeMode) => {
    const health = runtimeMode === "legacy" ? legacyHealth : platformHealth;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...health, internalTopology: "secret" }), {
      headers: { "Content-Type": "application/json" }
    })));
    await expect(probeRuntimeMode(new AbortController().signal)).rejects.toMatchObject({
      code: "RUNTIME_MODE_PROBE_FAILED"
    });
  });

  it.each([
    () => new Response("not-json", { headers: { "Content-Type": "text/plain" } }),
    () => new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } }),
    () => new Response(JSON.stringify({ ...platformHealth, runtimeMode: "unknown" }), {
      headers: { "Content-Type": "application/json" }
    }),
    () => new Response(JSON.stringify({ type: "about:blank", status: 503, code: "DOWN", requestId: "id", title: "Down" }),
      { status: 503, headers: { "Content-Type": "application/problem+json" } })
  ])("fails closed for browser probe failures and never defaults to legacy", async (createResponse) => {
    vi.stubGlobal("fetch", vi.fn(async () => createResponse()));
    await expect(probeRuntimeMode(new AbortController().signal)).rejects.toMatchObject({ code: "RUNTIME_MODE_PROBE_FAILED" });
  });

  it("renders a stable fatal error without leaking the probe error", () => {
    const markup = renderToStaticMarkup(React.createElement(RuntimeEntryView, {
      entry: { status: "fatalError", code: "RUNTIME_MODE_PROBE_FAILED" }
    }));
    expect(markup).toContain("无法确定运行模式");
    expect(markup).not.toContain("stack");
  });

  it("loads the platform entry only for platform mode while legacy remains on App", () => {
    const PlatformEntry = vi.fn(() => React.createElement("main", { "data-runtime-mode": "platform-test" },
      "按需平台入口"));
    const markup = renderToStaticMarkup(React.createElement(RuntimeEntryView, {
      entry: { status: "ready", mode: "platform", basePath: "/" },
      platformEntry: PlatformEntry
    }));
    expect(markup).toContain('data-runtime-mode="platform-test"');
    expect(markup).toContain("按需平台入口");
    expect(PlatformEntry).toHaveBeenCalledTimes(1);
    PlatformEntry.mockClear();
    const legacyMarkup = renderToStaticMarkup(React.createElement(RuntimeEntryView, {
      entry: { status: "ready", mode: "legacy" },
      platformEntry: PlatformEntry
    }));
    expect(legacyMarkup).toContain("登录");
    expect(PlatformEntry).not.toHaveBeenCalled();
  });

  it("consumes platform invitation fragments after mode selection without touching legacy routes", () => {
    const platformHistory = { replaceState: vi.fn() };
    activateRuntimeEntry({ status: "ready", mode: "platform", basePath: "/" }, {
      href: "https://approval.example/#/accept-invitation?token=invitation-secret",
      origin: "https://approval.example",
      pathname: "/"
    }, platformHistory);
    expect(platformHistory.replaceState).toHaveBeenCalledWith(null, "", "/");
    expect(platformHistory.replaceState.mock.calls.flat().join(" ")).not.toContain("invitation-secret");
    expect(currentBrowserIdentityRoute()).toEqual({ name: "acceptInvitation", invitationToken: "invitation-secret" });

    const legacyHistory = { replaceState: vi.fn() };
    activateRuntimeEntry({ status: "ready", mode: "legacy" }, {
      href: "https://approval.example/#/reset-password?token=legacy-token",
      origin: "https://approval.example",
      pathname: "/"
    }, legacyHistory);
    expect(legacyHistory.replaceState).not.toHaveBeenCalled();
    disposeBrowserIdentityRoute();
    expect(currentBrowserIdentityRoute()).toEqual({ name: "root" });
  });

  it("turns route commit failure into a stable fatal entry and keeps the same URL retryable", () => {
    disposeBrowserIdentityRoute();
    const secret = "invitation-route-secret";
    const location = {
      href: `https://approval.example/#/accept-invitation?token=${secret}`,
      origin: "https://approval.example",
      pathname: "/"
    };
    const failedHistory = { replaceState: vi.fn(() => { throw new Error(`password=${secret}`); }) };

    const failedEntry = activateRuntimeEntry({ status: "ready", mode: "platform", basePath: "/" },
      location, failedHistory);
    expect(failedEntry).toEqual({ status: "fatalError", code: "IDENTITY_ROUTE_COMMIT_FAILED" });
    expect(JSON.stringify(failedEntry)).not.toContain(secret);
    expect(currentBrowserIdentityRoute()).toEqual({ name: "root" });

    const retryHistory = { replaceState: vi.fn() };
    const readyEntry = activateRuntimeEntry({ status: "ready", mode: "platform", basePath: "/" },
      location, retryHistory);
    expect(readyEntry).toEqual({ status: "ready", mode: "platform", basePath: "/" });
    expect(retryHistory.replaceState).toHaveBeenCalledTimes(1);
    expect(currentBrowserIdentityRoute()).toEqual({ name: "acceptInvitation", invitationToken: secret });
  });

  it("deduplicates the StrictMode subscribe-cleanup-resubscribe cycle", async () => {
    let resolve!: (selection: TestRuntimeSelection) => void;
    const probe = vi.fn((_signal: AbortSignal) => new Promise<TestRuntimeSelection>((done) => { resolve = done; }));
    const dispose = vi.fn();
    const loader = createRuntimeModeLoader(probe, dispose);
    const firstListener = vi.fn();
    const secondListener = vi.fn();

    const cleanupFirst = loader.subscribe(firstListener);
    cleanupFirst();
    const cleanupSecond = loader.subscribe(secondListener);
    await Promise.resolve();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls[0]?.[0].aborted).toBe(false);
    expect(dispose).not.toHaveBeenCalled();
    resolve({ mode: "platform", basePath: "/" });
    await Promise.resolve();
    expect(firstListener).not.toHaveBeenCalled();
    expect(secondListener).toHaveBeenCalledWith({ status: "ready", mode: "platform", basePath: "/" });
    cleanupSecond();
    await Promise.resolve();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("isolates a throwing listener and reports only one stable failure event", async () => {
    const secret = "token=listener-error-secret";
    const diagnosticsBefore = readRuntimeListenerDiagnostics();
    const sink = vi.fn();
    const loader = createRuntimeModeLoader(async () => ({ mode: "legacy" }), () => undefined, sink);
    loader.subscribe(() => { throw new Error(secret); });
    const healthyListener = vi.fn();
    loader.subscribe(healthyListener);

    await Promise.resolve();

    expect(healthyListener).toHaveBeenCalledWith({ status: "ready", mode: "legacy" });
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith({ code: "RUNTIME_LISTENER_FAILED" });
    expect(Object.isFrozen(sink.mock.calls[0]![0])).toBe(true);
    expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
    expect(readRuntimeListenerDiagnostics()).toEqual(diagnosticsBefore);
  });

  it("contains a throwing listener-error sink and continues notifying later listeners", async () => {
    const secret = "password=listener-sink-secret";
    const diagnosticsBefore = readRuntimeListenerDiagnostics();
    const reportError = vi.fn();
    vi.stubGlobal("reportError", reportError);
    const sink = vi.fn(() => { throw new Error(secret); });
    const loader = createRuntimeModeLoader(async () => ({ mode: "legacy" }), () => undefined, sink);
    loader.subscribe(() => { throw new Error("token=listener-secret"); });
    const healthyListener = vi.fn();
    loader.subscribe(healthyListener);

    await Promise.resolve();

    expect(healthyListener).toHaveBeenCalledWith({ status: "ready", mode: "legacy" });
    expect(sink).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![0]).toBeInstanceOf(Error);
    expect((reportError.mock.calls[0]![0] as Error).message).toBe("RUNTIME_LISTENER_FAILED");
    expect(JSON.stringify(reportError.mock.calls)).not.toContain(secret);
    expect(readRuntimeListenerDiagnostics()).toEqual({
      code: "RUNTIME_LISTENER_FAILED",
      count: diagnosticsBefore.count + 1
    });
  });

  it("keeps production notifications non-throwing when reportError is unavailable or throws", async () => {
    const diagnosticsBefore = readRuntimeListenerDiagnostics();
    const healthyListeners: ReturnType<typeof vi.fn>[] = [];
    for (const reporter of [undefined, vi.fn(() => { throw new Error("password=reporter-secret"); })]) {
      vi.stubGlobal("reportError", reporter);
      const loader = createRuntimeModeLoader(async () => ({ mode: "legacy" }));
      loader.subscribe(() => { throw new Error("token=production-listener-secret"); });
      const healthyListener = vi.fn();
      healthyListeners.push(healthyListener);
      loader.subscribe(healthyListener);
      await Promise.resolve();
    }

    for (const healthyListener of healthyListeners) {
      expect(healthyListener).toHaveBeenCalledWith({ status: "ready", mode: "legacy" });
    }
    expect(readRuntimeListenerDiagnostics()).toEqual({
      code: "RUNTIME_LISTENER_FAILED",
      count: diagnosticsBefore.count + 2
    });
    expect(Object.isFrozen(readRuntimeListenerDiagnostics())).toBe(true);
  });

  it("isolates cached-entry listeners in their notification microtasks", async () => {
    const secret = "token=cached-listener-secret";
    const sink = vi.fn();
    const loader = createRuntimeModeLoader(async () => ({ mode: "legacy" }), () => undefined, sink);
    loader.subscribe(vi.fn());
    await Promise.resolve();

    loader.subscribe(() => { throw new Error(secret); });
    const healthyListener = vi.fn();
    loader.subscribe(healthyListener);
    await Promise.resolve();

    expect(healthyListener).toHaveBeenCalledWith({ status: "ready", mode: "legacy" });
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith({ code: "RUNTIME_LISTENER_FAILED" });
    expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
  });

  it("shares one invitation snapshot across roots and clears it only after the final unsubscribe", async () => {
    disposeBrowserIdentityRoute();
    let resolve!: (selection: TestRuntimeSelection) => void;
    const probe = vi.fn((_signal: AbortSignal) => new Promise<TestRuntimeSelection>((done) => { resolve = done; }));
    const dispose = vi.fn();
    const loader = createRuntimeModeLoader(probe, dispose);
    const history = { replaceState: vi.fn() };
    const location = {
      href: "https://approval.example/#/accept-invitation?token=invitation-secret",
      origin: "https://approval.example",
      pathname: "/"
    };
    const first = loader.subscribe((entry) => { activateRuntimeEntry(entry, location, history); });
    const second = loader.subscribe((entry) => { activateRuntimeEntry(entry, location, history); });

    resolve({ mode: "platform", basePath: "/" });
    await Promise.resolve();
    expect(history.replaceState).toHaveBeenCalledTimes(1);
    expect(currentBrowserIdentityRoute()).toEqual({ name: "acceptInvitation", invitationToken: "invitation-secret" });
    first();
    await Promise.resolve();
    expect(dispose).not.toHaveBeenCalled();
    expect(currentBrowserIdentityRoute()).toMatchObject({ invitationToken: "invitation-secret" });
    second();
    await Promise.resolve();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(currentBrowserIdentityRoute()).toEqual({ name: "root" });
  });

  it("supports explicit HMR disposal without retaining route memory or a stale cached mode", async () => {
    disposeBrowserIdentityRoute();
    const dispose = vi.fn();
    const probe = vi.fn(async () => ({ mode: "platform", basePath: "/" } as const));
    const loader = createRuntimeModeLoader(probe, dispose);
    const history = { replaceState: vi.fn() };
    loader.subscribe((entry) => activateRuntimeEntry(entry, {
      href: "https://approval.example/#/accept-invitation?token=hmr-secret",
      origin: "https://approval.example",
      pathname: "/"
    }, history));
    await Promise.resolve();
    expect(currentBrowserIdentityRoute()).toMatchObject({ invitationToken: "hmr-secret" });

    loader.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(currentBrowserIdentityRoute()).toEqual({ name: "root" });

    loader.subscribe(vi.fn());
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("clears route and CSRF memory for a custom loader after its final unsubscribe", async () => {
    disposeIdentityClient();
    disposeBrowserIdentityRoute();
    const session = {
      user: {
        id: "01890f1e-9b4a-7cc2-8f00-000000000001",
        emailNormalized: "user@example.test",
        displayName: "User",
        platformRole: "admin",
        status: "active",
        mfaStatus: "enabled",
        mfaEnabledAt: "2026-07-13T00:00:00.000Z",
        createdAt: "2026-07-13T00:00:00.000Z",
        updatedAt: "2026-07-13T00:00:00.000Z"
      },
      globalCapabilities: ["projects.create"],
      projects: [],
      csrfToken: "custom-loader-csrf"
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(session), {
      headers: { "Content-Type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);
    await getSession();
    const loader = createRuntimeModeLoader(async () => ({ mode: "legacy" }));
    const cleanup = loader.subscribe(vi.fn());
    await Promise.resolve();
    cleanup();
    await Promise.resolve();

    await expect(createProject({ name: "must not send" })).rejects.toMatchObject({ code: "CSRF_UNAVAILABLE" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts after final unmount and ignores a stale request that resolves after a new version", async () => {
    const deferred: Array<{ signal: AbortSignal; resolve: (selection: TestRuntimeSelection) => void }> = [];
    const probe = vi.fn((signal: AbortSignal) => new Promise<TestRuntimeSelection>((resolve) => {
      deferred.push({ signal, resolve });
    }));
    const loader = createRuntimeModeLoader(probe);
    const staleListener = vi.fn();
    const cleanup = loader.subscribe(staleListener);
    cleanup();
    await Promise.resolve();
    expect(deferred[0]?.signal.aborted).toBe(true);

    const currentListener = vi.fn();
    loader.subscribe(currentListener);
    deferred[0]!.resolve({ mode: "legacy" });
    deferred[1]!.resolve({ mode: "platform", basePath: "/" });
    await Promise.resolve();
    expect(staleListener).not.toHaveBeenCalled();
    expect(currentListener).toHaveBeenCalledWith({ status: "ready", mode: "platform", basePath: "/" });
  });
});
