import { UsageError, createDockerRunner, runPlatformDeps } from "./platform-deps-core.mjs";

const [action, ...args] = process.argv.slice(2);

try {
  runPlatformDeps({ action, args, env: process.env, runner: createDockerRunner() });
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = error instanceof UsageError ? 2 : 1;
}
