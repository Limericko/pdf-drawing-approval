import { spawn as nodeSpawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";

const UI_GALLERY_HOST = "127.0.0.1";
const UI_GALLERY_PORT = 34173;
const configArgs = ["test", "--config", "playwright.ui.config.ts"];

export function resolveUiGalleryE2ECommand(args) {
  return [...configArgs, ...args];
}

export async function runUiGalleryE2E(args, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const createServer = options.createServer ?? createViteServer;
  let server;
  try {
    server = await createServer({
      configFile: path.resolve(cwd, "vite.config.ts"),
      server: {
        host: UI_GALLERY_HOST,
        port: UI_GALLERY_PORT,
        strictPort: true
      }
    });
    await server.listen();
    return await runPlaywright(resolveUiGalleryE2ECommand(args), options);
  } finally {
    await server?.close();
  }
}

function runPlaywright(command, options) {
  const cwd = options.cwd ?? process.cwd();
  const spawn = options.spawn ?? nodeSpawn;
  const playwrightCli = options.playwrightCli ?? path.resolve(cwd, "node_modules/@playwright/test/cli.js");
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(process.execPath, [playwrightCli, ...command], {
        cwd,
        env: options.env ?? process.env,
        stdio: "inherit",
        shell: false
      });
    } catch (error) {
      reject(error);
      return;
    }
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

function errorCode(error) {
  return error instanceof Error ? error.message : "UI_GALLERY_E2E_RUN_FAILED";
}

const isMain = Boolean(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isMain) {
  runUiGalleryE2E(process.argv.slice(2)).then(
    (status) => { process.exitCode = status; },
    (error) => {
      process.stderr.write(`${errorCode(error)}\n`);
      process.exitCode = 1;
    }
  );
}
