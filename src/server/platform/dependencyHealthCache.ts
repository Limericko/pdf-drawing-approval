export type DependencyHealthResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; code: "DEPENDENCY_UNAVAILABLE" | "DEPENDENCY_TIMEOUT" }>;

type DependencyHealthCacheOptions = {
  readonly probe: () => Promise<void>;
  readonly timeoutMs: number;
  readonly ttlMs: number;
  readonly now?: () => number;
};

const timeoutMarker = Symbol("dependency-health-timeout");

export function createDependencyHealthCache(options: DependencyHealthCacheOptions) {
  if (!options || typeof options.probe !== "function" || !positiveInteger(options.timeoutMs) ||
      !positiveInteger(options.ttlMs) || (options.now !== undefined && typeof options.now !== "function")) {
    throw new Error("DEPENDENCY_HEALTH_CACHE_OPTIONS_INVALID");
  }
  const now = options.now ?? Date.now;
  let cached: { readonly expiresAt: number; readonly result: DependencyHealthResult } | undefined;
  let inFlight: Promise<DependencyHealthResult> | undefined;
  let probeInFlight: Promise<void> | undefined;

  return Object.freeze({
    check(): Promise<DependencyHealthResult> {
      const current = now();
      if (cached && (current < cached.expiresAt ||
          (probeInFlight && !cached.result.ok && cached.result.code === "DEPENDENCY_TIMEOUT"))) {
        return Promise.resolve(cached.result);
      }
      if (inFlight) return inFlight;
      const operation = probeInFlight ?? startProbe();
      inFlight = runBoundedProbe(operation, options.timeoutMs)
        .then((result) => {
          cached = { expiresAt: now() + options.ttlMs, result };
          return result;
        })
        .finally(() => { inFlight = undefined; });
      return inFlight;
    }
  });

  function startProbe() {
    let operation: Promise<void>;
    try {
      operation = Promise.resolve(options.probe());
    } catch (error) {
      operation = Promise.reject(error);
    }
    probeInFlight = operation;
    void operation.then(clearProbe, clearProbe);
    return operation;

    function clearProbe() {
      if (probeInFlight === operation) probeInFlight = undefined;
    }
  }
}

async function runBoundedProbe(operation: Promise<void>, timeoutMs: number): Promise<DependencyHealthResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof timeoutMarker>((resolve) => {
    timer = setTimeout(() => resolve(timeoutMarker), timeoutMs);
    timer.unref?.();
  });
  try {
    const result = await Promise.race([operation, timeout]);
    return result === timeoutMarker
      ? Object.freeze({ ok: false as const, code: "DEPENDENCY_TIMEOUT" as const })
      : Object.freeze({ ok: true as const });
  } catch {
    return Object.freeze({ ok: false as const, code: "DEPENDENCY_UNAVAILABLE" as const });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function positiveInteger(value: number) {
  return Number.isSafeInteger(value) && value > 0;
}
