import { runWithTimeout } from "./run-with-timeout-core.mjs";

const [timeoutText, requestedCommand, ...requestedArgs] = process.argv.slice(2);
const timeoutMs = Number(timeoutText);

if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !requestedCommand) {
  process.stderr.write("Usage: node scripts/run-with-timeout.mjs <positive-ms> <command> [args...]\n");
  process.exitCode = 2;
} else {
  process.exitCode = await runWithTimeout(timeoutMs, requestedCommand, requestedArgs);
}
