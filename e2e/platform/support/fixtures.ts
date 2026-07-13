import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test as base, expect } from "@playwright/test";
import type { PlatformE2ESeed } from "./seed.ts";

export type PlatformE2EState = {
  readonly runId: string;
  readonly databaseName: string;
  readonly storageCleanupRoot: string;
  readonly storagePrefix: string;
  readonly webUrl: string;
  readonly apiUrl: string;
  readonly mailpitUrl: string;
  readonly seed: PlatformE2ESeed;
};

type PlatformFixtures = {
  readonly browserMessages: string[];
};
type PlatformWorkerFixtures = { readonly platform: PlatformE2EState };

export const platformStateFile = path.resolve(".cache/platform-e2e/state.json");

export const test = base.extend<PlatformFixtures, PlatformWorkerFixtures>({
  platform: [async ({}, use) => { await use(await readPlatformE2EState()); }, { scope: "worker" }],
  browserMessages: async ({ page }, use) => {
    const messages: string[] = [];
    page.on("console", (message) => messages.push(`${message.type()}:${message.text()}`));
    page.on("pageerror", (error) => messages.push(`pageerror:${error.message}`));
    await use(messages);
  }
});

export async function readPlatformE2EState() {
  const parsed = JSON.parse(await readFile(platformStateFile, "utf8")) as unknown;
  if (!isPlatformE2EState(parsed)) throw new Error("PLATFORM_E2E_STATE_INVALID");
  return parsed;
}

export async function publishPlatformE2EState(state: PlatformE2EState) {
  const temporary = `${platformStateFile}.${process.pid}.tmp`;
  const publicState: PlatformE2EState = {
    runId: state.runId,
    databaseName: state.databaseName,
    storageCleanupRoot: state.storageCleanupRoot,
    storagePrefix: state.storagePrefix,
    webUrl: state.webUrl,
    apiUrl: state.apiUrl,
    mailpitUrl: state.mailpitUrl,
    seed: {
      adminEmail: state.seed.adminEmail,
      unauthorizedProjectId: state.seed.unauthorizedProjectId
    }
  };
  await mkdir(path.dirname(platformStateFile), { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(publicState)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, platformStateFile);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function publishStateBeforeStart<TState, TClient>(state: TState,
  publish: (state: TState) => Promise<void>, start: () => TClient) {
  await publish(state);
  return start();
}

function isPlatformE2EState(value: unknown): value is PlatformE2EState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Partial<PlatformE2EState>;
  return typeof state.runId === "string" && typeof state.databaseName === "string" &&
    typeof state.storageCleanupRoot === "string" &&
    typeof state.storagePrefix === "string" && typeof state.webUrl === "string" &&
    typeof state.apiUrl === "string" && typeof state.mailpitUrl === "string" &&
    Boolean(state.seed?.adminEmail && state.seed.unauthorizedProjectId);
}

export { expect };
