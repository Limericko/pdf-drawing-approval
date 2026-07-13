import { spawnSync as nodeSpawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const configArgs = ["test", "--config", "playwright.platform.config.ts"];
const defaultGroups = Object.freeze([
  ["--project=desktop-chromium", "e2e/platform/identity-security.spec.ts"],
  ["--project=desktop-chromium", "e2e/platform/session-csrf.spec.ts", "e2e/platform/project-access.spec.ts"],
  ["--project=mobile-chromium", "e2e/platform/identity-security.spec.ts"]
]);

export function resolvePlatformE2ECommands(args) {
  const groups = args.length > 0 ? [Array.from(args)] : defaultGroups;
  return groups.map((group) => [...configArgs, ...group]);
}

export function runPlatformE2E(args, options = {}) {
  const spawnSync = options.spawnSync ?? nodeSpawnSync;
  const playwrightCli = options.playwrightCli ?? path.resolve("node_modules/@playwright/test/cli.js");
  for (const command of resolvePlatformE2ECommands(args)) {
    const result = spawnSync(process.execPath, [playwrightCli, ...command], {
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      stdio: "inherit",
      shell: false
    });
    if (result.error) throw result.error;
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

const isMain = Boolean(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isMain) process.exitCode = runPlatformE2E(process.argv.slice(2));
