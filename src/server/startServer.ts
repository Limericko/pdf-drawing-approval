import type { Server as HttpServer } from "node:http";
import { loadConfig } from "./config.ts";
import { createServer } from "./server.ts";
import { cleanupTempUploads } from "./uploads/tempUploads.ts";

const defaultTempUploadMaxAgeMs = 24 * 60 * 60 * 1000;
const defaultTempUploadCleanupIntervalMs = 60 * 60 * 1000;

export type TempUploadCleanupOptions = {
  maxAgeMs?: number;
  intervalMs?: number;
  onError?: (error: Error) => void;
};

export type TempUploadCleanupHandle = {
  firstRun: Promise<number>;
  stop: () => void;
};

export type StartPdfApprovalServerOptions = {
  host?: string;
  logRoot?: string;
  backupRoot?: string;
  restart?: () => void;
  tempUploadCleanup?: false | TempUploadCleanupOptions;
  onError?: (error: Error) => void;
  onListening?: (info: { host: string; port: number; localUrl: string }) => void;
};

export function startTempUploadCleanup(rootDir: string, options: TempUploadCleanupOptions = {}): TempUploadCleanupHandle {
  const maxAgeMs = options.maxAgeMs ?? defaultTempUploadMaxAgeMs;
  const intervalMs = options.intervalMs ?? defaultTempUploadCleanupIntervalMs;
  const onError =
    options.onError ??
    ((error: Error) => {
      console.error("Temporary upload cleanup failed.", error);
    });

  const run = async () => {
    try {
      return await cleanupTempUploads(rootDir, maxAgeMs);
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
      return 0;
    }
  };

  const firstRun = run();
  const timer = setInterval(() => {
    void run();
  }, intervalMs);
  timer.unref?.();

  return {
    firstRun,
    stop: () => clearInterval(timer)
  };
}

export function startPdfApprovalServer(options: StartPdfApprovalServerOptions = {}): HttpServer {
  const config = loadConfig();
  const host = options.host ?? "0.0.0.0";
  const app = createServer(config, {
    backupRoot: options.backupRoot,
    logRoot: options.logRoot,
    restart: options.restart
  });

  const server = app.listen(config.port, host, () => {
    const localUrl = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${config.port}`;
    console.log(`PDF approval server listening on http://${host}:${config.port}`);
    options.onListening?.({ host, port: config.port, localUrl });
  });
  server.on("error", (error) => {
    if (options.onError) {
      options.onError(error);
      return;
    }
    console.error("PDF approval server failed to start.", error);
    throw error;
      });

  const cleanup =
    options.tempUploadCleanup === false || process.env.NODE_ENV === "test"
      ? null
      : startTempUploadCleanup(config.dataDir, options.tempUploadCleanup);
  if (cleanup) server.on("close", cleanup.stop);

  return server;
}
