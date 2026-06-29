import fs from "node:fs/promises";

export type StableFileResult =
  | { ok: true }
  | { ok: false; reason: "missing" | "timeout" };

export async function waitForStableFile(
  filePath: string,
  options: { intervalMs?: number; requiredStableChecks?: number; timeoutMs?: number } = {}
): Promise<StableFileResult> {
  const intervalMs = options.intervalMs ?? 1000;
  const requiredStableChecks = options.requiredStableChecks ?? 2;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const startedAt = Date.now();
  let previous: { size: number; mtimeMs: number } | null = null;
  let stableChecks = 0;

  while (Date.now() - startedAt <= timeoutMs) {
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return { ok: false, reason: "missing" };
    }

    const current = { size: stat.size, mtimeMs: stat.mtimeMs };
    if (previous && previous.size === current.size && previous.mtimeMs === current.mtimeMs) {
      stableChecks += 1;
      if (stableChecks >= requiredStableChecks) {
        return { ok: true };
      }
    } else {
      stableChecks = 0;
    }

    previous = current;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return { ok: false, reason: "timeout" };
}
