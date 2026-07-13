import { lazy, Suspense, useEffect, useState, type ComponentType, type FC } from "react";
import { z } from "zod";
import { App } from "./App.tsx";
import { disposeIdentityClient } from "./api/identityClient.ts";
import { isDesktopClient } from "./clientConfig.ts";
import { disposeBrowserIdentityRoute, IdentityRouteCommitError,
  initializeBrowserIdentityRoute } from "./features/identity/identityRoutes.ts";

const LazyPlatformIdentityApp = lazy(async () => {
  const module = await import("./features/identity/PlatformIdentityApp.tsx");
  return { default: module.PlatformIdentityApp };
});

type RuntimeSelection = { readonly mode: "legacy" } | { readonly mode: "platform"; readonly basePath: string };
export type RuntimeEntry =
  | { readonly status: "loading" }
  | ({ readonly status: "ready" } & RuntimeSelection)
  | { readonly status: "fatalError";
      readonly code: "RUNTIME_MODE_PROBE_FAILED" | "IDENTITY_ROUTE_COMMIT_FAILED" };

type RuntimeProbe = (signal: AbortSignal) => Promise<RuntimeSelection>;
type RuntimeListener = (entry: RuntimeEntry) => void;
type RuntimeListenerErrorSink = (failure: RuntimeListenerFailure) => void;

export type RuntimeListenerFailure = Readonly<{ readonly code: "RUNTIME_LISTENER_FAILED" }>;
export type RuntimeListenerDiagnostics = Readonly<RuntimeListenerFailure & { readonly count: number }>;

export class RuntimeBootError {
  readonly code = "RUNTIME_MODE_PROBE_FAILED" as const;
}

const publicHealthFields = {
  ok: z.literal(true),
  appName: z.string().min(1).max(120),
  version: z.string().min(1).max(64),
  apiCompatVersion: z.number().int().nonnegative()
} as const;
const platformHealthSchema = z.object({
  ...publicHealthFields,
  runtimeMode: z.literal("platform"),
  basePath: z.string().regex(/^\/(?:[^/?#]+\/)*$/)
}).strict();
const legacyHealthSchema = z.object({
  ...publicHealthFields,
  runtimeMode: z.literal("legacy"),
  port: z.number().int().min(0).max(65_535),
  lanUrls: z.array(z.string().url()),
  startedAt: z.string().datetime()
}).strict();
const healthSchema = z.discriminatedUnion("runtimeMode", [platformHealthSchema, legacyHealthSchema]);
const runtimeListenerFailure = Object.freeze({ code: "RUNTIME_LISTENER_FAILED" } as const);
let runtimeListenerFailureCount = 0;

export function readRuntimeListenerDiagnostics(): RuntimeListenerDiagnostics {
  return Object.freeze({ ...runtimeListenerFailure, count: runtimeListenerFailureCount });
}

export async function probeRuntimeMode(signal: AbortSignal): Promise<RuntimeSelection> {
  try {
    const response = await fetch("/health", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      signal
    });
    if (!response.ok || response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
      "application/json") throw new RuntimeBootError();
    const parsed = healthSchema.safeParse(JSON.parse(await response.text()) as unknown);
    if (!parsed.success) throw new RuntimeBootError();
    return parsed.data.runtimeMode === "platform"
      ? { mode: "platform", basePath: parsed.data.basePath }
      : { mode: "legacy" };
  } catch (error) {
    if (error instanceof RuntimeBootError) throw error;
    throw new RuntimeBootError();
  }
}

export function createRuntimeModeLoader(
  probe: RuntimeProbe = probeRuntimeMode,
  onDispose: () => void = () => undefined,
  onListenerError: RuntimeListenerErrorSink = reportRuntimeListenerFailure
) {
  const subscriptions = new Set<{ readonly listener: RuntimeListener }>();
  let version = 0;
  let cached: RuntimeEntry | undefined;
  let inFlight: { readonly version: number; readonly controller: AbortController } | undefined;

  function start() {
    if (cached || inFlight) return;
    const controller = new AbortController();
    const requestVersion = ++version;
    inFlight = { version: requestVersion, controller };
    let operation: Promise<RuntimeSelection>;
    try {
      operation = Promise.resolve(probe(controller.signal));
    } catch {
      operation = Promise.reject(new RuntimeBootError());
    }
    void operation.then(
      (selection) => settle(requestVersion, { status: "ready", ...selection }),
      () => {
        if (!controller.signal.aborted) settle(requestVersion,
          { status: "fatalError", code: "RUNTIME_MODE_PROBE_FAILED" });
      }
    );
  }

  function settle(requestVersion: number, entry: RuntimeEntry) {
    if (!inFlight || inFlight.version !== requestVersion || version !== requestVersion) return;
    inFlight = undefined;
    cached = entry;
    for (const subscription of subscriptions) notifyRuntimeListener(subscription.listener, entry, onListenerError);
  }

  return Object.freeze({
    subscribe(listener: RuntimeListener) {
      const subscription = { listener };
      subscriptions.add(subscription);
      if (cached) queueMicrotask(() => {
        if (subscriptions.has(subscription)) notifyRuntimeListener(listener, cached!, onListenerError);
      });
      else start();
      return () => {
        if (!subscriptions.delete(subscription)) return;
        queueMicrotask(() => {
          if (subscriptions.size !== 0) return;
          if (inFlight) {
            version += 1;
            inFlight.controller.abort();
            inFlight = undefined;
          }
          releaseRuntimeMemory(onDispose);
        });
      };
    },
    dispose() {
      version += 1;
      inFlight?.controller.abort();
      inFlight = undefined;
      cached = undefined;
      subscriptions.clear();
      releaseRuntimeMemory(onDispose);
    }
  });
}

const runtimeModeLoader = createRuntimeModeLoader();

if (import.meta.hot) import.meta.hot.dispose(() => runtimeModeLoader.dispose());

export type RuntimeAppProps = {
  readonly desktopClient?: boolean;
  readonly loader?: ReturnType<typeof createRuntimeModeLoader>;
};

export const RuntimeApp: FC<RuntimeAppProps> = ({ desktopClient = isDesktopClient(), loader = runtimeModeLoader }) => {
  const [entry, setEntry] = useState<RuntimeEntry>(() => desktopClient
    ? { status: "ready", mode: "legacy" }
    : { status: "loading" });

  useEffect(() => {
    if (desktopClient) return;
    const unsubscribe = loader.subscribe((nextEntry) => setEntry(activateRuntimeEntry(nextEntry, location, history)));
    return unsubscribe;
  }, [desktopClient, loader]);

  return <RuntimeEntryView entry={entry} />;
};

export function activateRuntimeEntry(entry: RuntimeEntry, locationInput: {
  readonly href: string;
  readonly origin: string;
  readonly pathname: string;
}, historyInput: { replaceState(data: unknown, unused: string, url?: string | URL | null): void }) {
  if (entry.status === "ready" && entry.mode === "platform") {
    try {
      initializeBrowserIdentityRoute(locationInput, historyInput, entry.basePath);
    } catch (error) {
      if (error instanceof IdentityRouteCommitError) {
        return { status: "fatalError", code: "IDENTITY_ROUTE_COMMIT_FAILED" } as const;
      }
      throw error;
    }
  }
  return entry;
}

export function RuntimeEntryView({ entry, platformEntry: PlatformEntry }: {
  readonly entry: RuntimeEntry;
  readonly platformEntry?: ComponentType;
}) {
  if (entry.status === "loading") return <main aria-busy="true">正在确认服务运行模式…</main>;
  if (entry.status === "fatalError") {
    return <main role="alert">无法确定运行模式，请刷新页面或联系管理员。</main>;
  }
  if (entry.mode === "legacy") return <App />;
  if (PlatformEntry) return <PlatformEntry />;
  return <Suspense fallback={<main aria-busy="true">正在加载安全访问入口…</main>}>
    <LazyPlatformIdentityApp />
  </Suspense>;
}

function disposeRuntimeMemory() {
  disposeIdentityClient();
  disposeBrowserIdentityRoute();
}

function releaseRuntimeMemory(onDispose: () => void) {
  disposeRuntimeMemory();
  onDispose();
}

function notifyRuntimeListener(listener: RuntimeListener, entry: RuntimeEntry, onListenerError: RuntimeListenerErrorSink) {
  try {
    listener(entry);
  } catch {
    notifyRuntimeListenerError(onListenerError);
  }
}

function notifyRuntimeListenerError(onListenerError: RuntimeListenerErrorSink) {
  try {
    onListenerError(runtimeListenerFailure);
  } catch {
    reportRuntimeListenerFailure(runtimeListenerFailure);
  }
}

function reportRuntimeListenerFailure(failure: RuntimeListenerFailure) {
  runtimeListenerFailureCount += 1;
  const reporter = (globalThis as { readonly reportError?: (error: unknown) => void }).reportError;
  if (typeof reporter !== "function") return false;
  try {
    reporter(new Error(failure.code));
    return true;
  } catch {
    return false;
  }
}
