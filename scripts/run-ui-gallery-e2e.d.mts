export function resolveUiGalleryE2ECommand(args: readonly string[]): string[];

interface UiGalleryViteServer {
  listen(): Promise<unknown>;
  close(): Promise<unknown>;
}

interface UiGalleryChildProcess {
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "exit", listener: (code: number | null) => void): this;
}

export function runUiGalleryE2E(args: readonly string[], options?: {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly playwrightCli?: string;
  readonly createServer?: (inlineConfig?: import("vite").InlineConfig) => Promise<UiGalleryViteServer>;
  readonly spawn?: (
    command: string,
    args: readonly string[],
    options: import("node:child_process").SpawnOptions
  ) => UiGalleryChildProcess;
}): Promise<number>;
