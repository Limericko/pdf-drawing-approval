import { spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

let child;
let stopping = false;
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxCli = path.join(rootDir, "node_modules", "tsx", "dist", "cli.mjs");
const stdoutLogPath = path.join(rootDir, "server.log");
const stderrLogPath = path.join(rootDir, "server.err.log");

function tee(chunk, output, logPath) {
  output.write(chunk);
  fs.appendFile(logPath, chunk, () => {});
}

function start() {
  child = spawn(process.execPath, [tsxCli, "src/server/index.ts"], {
    cwd: rootDir,
    stdio: ["inherit", "pipe", "pipe"],
    shell: false
  });
  child.stdout?.on("data", (chunk) => tee(chunk, process.stdout, stdoutLogPath));
  child.stderr?.on("data", (chunk) => tee(chunk, process.stderr, stderrLogPath));

  child.on("exit", (code) => {
    if (stopping) return;
    if (code === 42) {
      console.log("PDF approval server restarting...");
      setTimeout(start, 800);
      return;
    }

    process.exit(code ?? 0);
  });
}

process.on("SIGINT", () => {
  stopping = true;
  child?.kill("SIGINT");
  process.exit(0);
});

process.on("SIGTERM", () => {
  stopping = true;
  child?.kill("SIGTERM");
  process.exit(0);
});

start();
