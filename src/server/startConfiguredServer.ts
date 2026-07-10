import type { Server as HttpServer } from "node:http";
import { resolveRuntimeMode } from "./runtimeMode.ts";
import { startPdfApprovalServer } from "./startServer.ts";

type PlatformServerModule<T> = {
  startPlatformWebServer: () => T | Promise<T>;
};

export type StartConfiguredServerOptions<TLegacy, TPlatform = TLegacy> = {
  env?: NodeJS.ProcessEnv;
  startLegacy?: () => TLegacy;
  loadPlatform?: () => Promise<PlatformServerModule<TPlatform>>;
};

export function startConfiguredServer(): Promise<HttpServer>;
export function startConfiguredServer<TLegacy, TPlatform>(
  options: StartConfiguredServerOptions<TLegacy, TPlatform>
): Promise<TLegacy | TPlatform>;
export async function startConfiguredServer<TLegacy, TPlatform>(
  options?: StartConfiguredServerOptions<TLegacy, TPlatform>
): Promise<TLegacy | TPlatform | HttpServer> {
  const runtimeMode = resolveRuntimeMode(options?.env ?? process.env);
  if (runtimeMode === "legacy") {
    return options?.startLegacy ? options.startLegacy() : startPdfApprovalServer();
  }

  if (options?.loadPlatform) {
    const platformModule = await options.loadPlatform();
    return platformModule.startPlatformWebServer();
  }

  // @ts-expect-error Task 19 will add the platform runtime module.
  const platformModule = (await import("./platform/startPlatformWebServer.ts")) as PlatformServerModule<HttpServer>;
  return platformModule.startPlatformWebServer();
}
