import { Router } from "express";
import { apiCompatVersion, appName, appVersion } from "../../shared/appVersion.ts";
import { createDependencyHealthCache } from "./dependencyHealthCache.ts";
import { asyncRoute } from "./http/asyncRoute.ts";

type Probe = () => Promise<void>;

export type PlatformHealthOptions = {
  readonly basePath: string;
  readonly core: { readonly postgres: Probe; readonly schema: Probe; readonly storage: Probe };
  readonly advisory?: { readonly worker?: Probe; readonly smtp?: Probe };
  readonly cache?: { readonly timeoutMs?: number; readonly ttlMs?: number; readonly storageTtlMs?: number };
};

const DEFAULT_HEALTH_TIMEOUT_MS = 1_000;
const DEFAULT_HEALTH_TTL_MS = 2_000;
const DEFAULT_STORAGE_HEALTH_TTL_MS = 60_000;

export function createPlatformHealthRouter(options: PlatformHealthOptions) {
  if (!options?.core || typeof options.core.postgres !== "function" ||
      typeof options.core.schema !== "function" || typeof options.core.storage !== "function") {
    throw new Error("PLATFORM_HEALTH_OPTIONS_INVALID");
  }
  if (!isCanonicalBasePath(options.basePath)) throw new Error("PLATFORM_HEALTH_BASE_PATH_INVALID");
  const timeoutMs = options.cache?.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const ttlMs = options.cache?.ttlMs ?? DEFAULT_HEALTH_TTL_MS;
  const storageTtlMs = options.cache?.storageTtlMs ?? DEFAULT_STORAGE_HEALTH_TTL_MS;
  const core = {
    postgres: createDependencyHealthCache({ probe: options.core.postgres, timeoutMs, ttlMs }),
    schema: createDependencyHealthCache({ probe: options.core.schema, timeoutMs, ttlMs }),
    storage: createDependencyHealthCache({ probe: options.core.storage, timeoutMs, ttlMs: storageTtlMs })
  };
  const advisory = {
    worker: options.advisory?.worker
      ? createDependencyHealthCache({ probe: options.advisory.worker, timeoutMs, ttlMs })
      : undefined,
    smtp: options.advisory?.smtp
      ? createDependencyHealthCache({ probe: options.advisory.smtp, timeoutMs, ttlMs })
      : undefined
  };

  const router = Router();
  router.get("/health", (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.status(200).json({ ok: true, runtimeMode: "platform", appName, version: appVersion, apiCompatVersion,
      basePath: options.basePath });
  });
  router.get("/health/live", (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.status(200).json({ ok: true });
  });
  router.get("/health/ready", asyncRoute(async (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const [postgres, schema, storage, worker, smtp] = await Promise.all([
      core.postgres.check(), core.schema.check(), core.storage.check(),
      advisory.worker?.check(), advisory.smtp?.check()
    ]);
    const dependencies = {
      postgres: postgres.ok ? "healthy" : "unhealthy",
      schema: schema.ok ? "healthy" : "unhealthy",
      storage: storage.ok ? "healthy" : "unhealthy"
    } as const;
    const advisories = {
      worker: worker === undefined ? "unknown" : worker.ok ? "healthy" : "unhealthy",
      smtp: smtp === undefined ? "unknown" : smtp.ok ? "healthy" : "unhealthy"
    } as const;
    const ok = postgres.ok && schema.ok && storage.ok;
    response.status(ok ? 200 : 503).json({ ok, dependencies, advisories });
  }));
  return router;
}

export function publicBasePath(publicBaseUrl: string) {
  let pathname: string;
  try {
    pathname = new URL(publicBaseUrl).pathname;
  } catch {
    throw new Error("PLATFORM_PUBLIC_BASE_URL_INVALID");
  }
  if (pathname === "/") return "/";
  const basePath = `${pathname.replace(/\/+$/, "")}/`;
  if (!isCanonicalBasePath(basePath)) throw new Error("PLATFORM_PUBLIC_BASE_URL_INVALID");
  return basePath;
}

function isCanonicalBasePath(value: string) {
  return /^\/(?:[^/?#]+\/)*$/.test(value);
}
