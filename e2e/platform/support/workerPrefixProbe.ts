type WorkerPrefixCleanupProbe = {
  readonly writePrefixedProbe: () => Promise<void>;
  readonly writeOutsideSentinel: () => Promise<void>;
  readonly enqueueCleanup: () => Promise<void>;
  readonly startWorker: () => Promise<void>;
  readonly isPrefixedProbeDeleted: () => Promise<boolean>;
  readonly isOutsideSentinelPresent: () => Promise<boolean>;
  readonly removeOutsideSentinel: () => Promise<void>;
  readonly now?: () => number;
  readonly delay?: (milliseconds: number) => Promise<void>;
  readonly timeoutMs?: number;
};

export async function runWorkerPrefixCleanupProbe(input: WorkerPrefixCleanupProbe) {
  const now = input.now ?? Date.now;
  const delay = input.delay ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = now() + (input.timeoutMs ?? 10_000);
  let sentinelWritten = false;
  await input.writePrefixedProbe();
  try {
    await input.writeOutsideSentinel();
    sentinelWritten = true;
    await input.enqueueCleanup();
    await input.startWorker();
    do {
      if (!await input.isOutsideSentinelPresent()) {
        throw new Error("PLATFORM_E2E_WORKER_PREFIX_SENTINEL_MISSING");
      }
      if (await input.isPrefixedProbeDeleted()) {
        if (!await input.isOutsideSentinelPresent()) {
          throw new Error("PLATFORM_E2E_WORKER_PREFIX_SENTINEL_MISSING");
        }
        return;
      }
      await delay(100);
    } while (now() < deadline);
    throw new Error("PLATFORM_E2E_WORKER_PREFIX_PROBE_TIMEOUT");
  } finally {
    if (sentinelWritten) await input.removeOutsideSentinel();
  }
}
