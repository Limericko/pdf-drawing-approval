export function resolvePlatformE2ECommands(args: readonly string[]): string[][];

export function runPlatformE2E(args: readonly string[], options?: {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly playwrightCli?: string;
  readonly spawnSync?: typeof import("node:child_process").spawnSync;
}): number;
