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

const platformServerModulePath = "./platform/startPlatformWebServer.ts";

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

  const platformModule = (await import(platformServerModulePath)) as PlatformServerModule<HttpServer>;
  return platformModule.startPlatformWebServer();
}
