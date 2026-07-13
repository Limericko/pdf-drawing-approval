export function resolvePlatformE2ECommands(args: readonly string[]): string[][];

export function runPlatformE2E(args: readonly string[], options?: {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly playwrightCli?: string;
  readonly serverPath?: string;
  readonly readinessTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
  readonly fork?: typeof import("node:child_process").fork;
  readonly spawn?: typeof import("node:child_process").spawn;
}): Promise<number>;
