import { input, password } from "@inquirer/prompts";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { BootstrapPlatformConfig } from "../platform/config/types.ts";
import { loadPlatformConfig } from "../platform/config/loadPlatformConfig.ts";
import { loadMigrationFiles } from "../platform/database/migrationFiles.ts";
import { createPlatformPool } from "../platform/database/pool.ts";
import { assertExpectedSchema } from "../platform/database/schemaVersion.ts";
import {
  BootstrapAdminError,
  createBootstrapAdminService,
  type BootstrapAdminChallenge
} from "../modules/identity/bootstrapAdminService.ts";

export type BootstrapCommandPrompt = {
  text(field: "email" | "displayName" | "totp"): Promise<string>;
  hidden(field: "password"): Promise<string>;
};

export type BootstrapAdminRuntime = {
  assertSchema(): Promise<void>;
  prepare(input: { readonly email: string; readonly displayName: string; readonly password: string }): Promise<BootstrapAdminChallenge>;
  close(): Promise<void>;
};

type CommandOptions = {
  readonly env: NodeJS.ProcessEnv;
  readonly argv: readonly string[];
  readonly prompt: BootstrapCommandPrompt;
  readonly output: { write(line: string): void; error(line: string): void };
  readonly openRuntime: (config: BootstrapPlatformConfig) => Promise<BootstrapAdminRuntime>;
};

const passwordHashOptions = Object.freeze({ memoryCost: 19_456, timeCost: 2, parallelism: 1, outputLen: 32 });

export function createInteractiveBootstrapPrompt(): BootstrapCommandPrompt {
  return {
    text(field) {
      const messages = { email: "Administrator email", displayName: "Administrator display name", totp: "Current TOTP" };
      return input({ message: messages[field] });
    },
    hidden() {
      return password({ message: "Administrator password", mask: "*" });
    }
  };
}

export async function runBootstrapAdminCommand(options: CommandOptions): Promise<0 | 1> {
  if (options.argv.length !== 0) {
    options.output.error("BOOTSTRAP_ADMIN_USAGE");
    return 1;
  }

  let runtime: BootstrapAdminRuntime | undefined;
  let primaryError: unknown;
  let cleanupError: unknown;
  try {
    const config = loadPlatformConfig(options.env, "bootstrap-admin");
    runtime = await options.openRuntime(config);
    await runtime.assertSchema();
    const email = await options.prompt.text("email");
    const displayName = await options.prompt.text("displayName");
    const enteredPassword = await options.prompt.hidden("password");
    const challenge = await runtime.prepare({ email, displayName, password: enteredPassword });
    options.output.write(challenge.otpauthUri);
    const token = await options.prompt.text("totp");
    const completed = await challenge.complete(token);
    options.output.write("RECOVERY_CODES");
    for (const code of completed.recoveryCodes) options.output.write(code);
  } catch (error) {
    primaryError = error;
  }

  if (runtime) {
    try {
      await runtime.close();
    } catch (error) {
      cleanupError = error;
    }
  }

  const lifecycleError = combineLifecycleErrors(primaryError, cleanupError);
  if (lifecycleError !== undefined) {
    options.output.error(safeErrorCode(lifecycleError));
    return 1;
  }
  return 0;
}

function combineLifecycleErrors(primaryError: unknown, cleanupError: unknown) {
  if (primaryError !== undefined && cleanupError !== undefined) {
    return new AggregateError(
      [primaryError, cleanupError],
      "BOOTSTRAP_ADMIN_RUNTIME_CLEANUP_FAILED",
      { cause: primaryError }
    );
  }
  return primaryError ?? cleanupError;
}

type OpenBootstrapRuntimeDependencies = {
  readonly createPool?: typeof createPlatformPool;
  readonly createService?: typeof createBootstrapAdminService;
};

export async function openBootstrapRuntime(
  config: BootstrapPlatformConfig,
  dependencies: OpenBootstrapRuntimeDependencies = {}
): Promise<BootstrapAdminRuntime> {
  const pool = (dependencies.createPool ?? createPlatformPool)(config.database, "platform-bootstrap-admin");
  try {
    const service = (dependencies.createService ?? createBootstrapAdminService)({
      pool,
      keyrings: config.keyrings,
      passwordHashOptions
    });
    return {
      async assertSchema() {
        await assertExpectedSchema(pool, await loadMigrationFiles());
      },
      prepare: service.prepare,
      close: () => pool.end()
    };
  } catch (primaryError) {
    try {
      await pool.end();
    } catch (cleanupError) {
      throw new AggregateError(
        [primaryError, cleanupError],
        "BOOTSTRAP_ADMIN_RUNTIME_INITIALIZATION_CLEANUP_FAILED",
        { cause: primaryError }
      );
    }
    throw primaryError;
  }
}

function safeErrorCode(error: unknown) {
  if (error instanceof BootstrapAdminError) return error.code;
  if (error && typeof error === "object" && "code" in error &&
      typeof error.code === "string" && /^(?:PLATFORM_CONFIG_INVALID|INSECURE_PRODUCTION_CONFIG|SCHEMA_VERSION_[A-Z_]+)$/.test(error.code)) {
    return error.code;
  }
  return "BOOTSTRAP_ADMIN_FAILED";
}

export async function bootstrapAdminMain(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv.slice(2)
) {
  return runBootstrapAdminCommand({
    env,
    argv,
    prompt: createInteractiveBootstrapPrompt(),
    output: {
      write: (line) => process.stdout.write(`${line}\n`),
      error: (line) => process.stderr.write(`${line}\n`)
    },
    openRuntime: openBootstrapRuntime
  });
}

const entry = process.argv[1];
if (entry && pathToFileURL(path.resolve(entry)).href === import.meta.url) {
  process.exitCode = await bootstrapAdminMain();
}
