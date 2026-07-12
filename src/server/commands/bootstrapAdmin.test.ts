import { input, password } from "@inquirer/prompts";
import { describe, expect, it, vi } from "vitest";
import {
  createInteractiveBootstrapPrompt,
  openBootstrapRuntime,
  runBootstrapAdminCommand,
  type BootstrapAdminRuntime,
  type BootstrapCommandPrompt
} from "./bootstrapAdmin.ts";
import { BootstrapAdminError } from "../modules/identity/bootstrapAdminService.ts";

vi.mock("@inquirer/prompts", () => ({ input: vi.fn(), password: vi.fn() }));

const plaintextPassword = "correct horse battery staple";
const recoveryCodes = Array.from({ length: 10 }, (_, index) => `CODE-${index}`);

function runtime(overrides: Partial<BootstrapAdminRuntime> = {}): BootstrapAdminRuntime {
  return {
    assertSchema: vi.fn(async () => undefined),
    prepare: vi.fn(async () => ({
      otpauthUri: "otpauth://totp/PDF%20Approval:admin%40example.test?secret=TEST",
      complete: vi.fn(async () => ({ recoveryCodes }))
    })),
    close: vi.fn(async () => undefined),
    ...overrides
  };
}

function commandOptions(overrides: Record<string, unknown> = {}) {
  const lines: string[] = [];
  const errors: string[] = [];
  const prompt: BootstrapCommandPrompt = {
    text: vi.fn(async (field) => field === "email" ? "admin@example.test" : field === "displayName" ? "Admin" : "123456"),
    hidden: vi.fn(async () => plaintextPassword)
  };
  const activeRuntime = runtime();
  return {
    lines,
    errors,
    prompt,
    activeRuntime,
    options: {
      env: {
        NODE_ENV: "test",
        PDF_APPROVAL_PLATFORM_BOOTSTRAP_DATABASE_URL: "postgresql://bootstrap:secret@localhost/app",
        PDF_APPROVAL_TOTP_KEYRING: "local-only-bootstrap-command-totp",
        PDF_APPROVAL_RECOVERY_HMAC_KEYRING: "local-only-bootstrap-command-recovery"
      },
      argv: [] as string[],
      prompt,
      output: { write: (line: string) => lines.push(line), error: (line: string) => errors.push(line) },
      openRuntime: vi.fn(async () => activeRuntime),
      ...overrides
    }
  };
}

describe("bootstrap admin command", () => {
  it("uses hidden password input and prints only the TOTP URI and ten recovery codes", async () => {
    const test = commandOptions();

    await expect(runBootstrapAdminCommand(test.options)).resolves.toBe(0);

    expect(test.prompt.hidden).toHaveBeenCalledWith("password");
    expect(test.activeRuntime.assertSchema).toHaveBeenCalledBefore(test.activeRuntime.prepare as never);
    expect(test.lines.join("\n")).toContain("otpauth://");
    for (const code of recoveryCodes) expect(test.lines).toContain(code);
    expect(`${test.lines.join("\n")}\n${test.errors.join("\n")}`).not.toContain(plaintextPassword);
    expect(test.activeRuntime.close).toHaveBeenCalledOnce();
  });

  it("maps the hidden field to the inquirer password prompt without echoing its value", async () => {
    vi.mocked(password).mockResolvedValueOnce(plaintextPassword);
    const prompt = createInteractiveBootstrapPrompt();

    await expect(prompt.hidden("password")).resolves.toBe(plaintextPassword);

    expect(password).toHaveBeenCalledWith(expect.objectContaining({ mask: "*" }));
    expect(input).not.toHaveBeenCalled();
  });

  it("rejects every argv value without repeating it or opening the runtime", async () => {
    const argvSecret = "password-from-argv";
    const test = commandOptions({ argv: [argvSecret] });

    await expect(runBootstrapAdminCommand(test.options)).resolves.toBe(1);

    expect(test.options.openRuntime).not.toHaveBeenCalled();
    expect(test.prompt.text).not.toHaveBeenCalled();
    expect(test.errors.join("\n")).not.toContain(argvSecret);
  });

  it("checks schema before prompting, sanitizes failures, and always closes resources", async () => {
    const databaseSecret = "database-password-must-not-leak";
    const failedRuntime = runtime({
      assertSchema: vi.fn(async () => {
        throw new Error(`SCHEMA_VERSION_MISMATCH:${databaseSecret}`);
      })
    });
    const test = commandOptions({ openRuntime: vi.fn(async () => failedRuntime) });

    await expect(runBootstrapAdminCommand(test.options)).resolves.toBe(1);

    expect(test.prompt.text).not.toHaveBeenCalled();
    expect(test.prompt.hidden).not.toHaveBeenCalled();
    expect(test.errors.join("\n")).toBe("BOOTSTRAP_ADMIN_FAILED");
    expect(test.errors.join("\n")).not.toContain(databaseSecret);
    expect(failedRuntime.close).toHaveBeenCalledOnce();
  });

  it("does not repeat a prompted password when preparation fails", async () => {
    const failedRuntime = runtime({
      prepare: vi.fn(async () => {
        throw new Error(`sensitive failure: ${plaintextPassword}`);
      })
    });
    const test = commandOptions({ openRuntime: vi.fn(async () => failedRuntime) });

    await expect(runBootstrapAdminCommand(test.options)).resolves.toBe(1);

    expect(test.errors).toEqual(["BOOTSTRAP_ADMIN_FAILED"]);
    expect(`${test.lines.join("\n")}\n${test.errors.join("\n")}`).not.toContain(plaintextPassword);
    expect(failedRuntime.close).toHaveBeenCalledOnce();
  });

  it("returns failure and reports a stable error when successful work is followed by a close failure", async () => {
    const cleanupSecret = "close-database-secret";
    const failedRuntime = runtime({
      close: vi.fn(async () => {
        throw new Error(`close failed: ${cleanupSecret}`);
      })
    });
    const test = commandOptions({ openRuntime: vi.fn(async () => failedRuntime) });

    await expect(runBootstrapAdminCommand(test.options)).resolves.toBe(1);

    expect(test.lines).toContain("RECOVERY_CODES");
    expect(test.errors).toEqual(["BOOTSTRAP_ADMIN_FAILED"]);
    expect(test.errors.join("\n")).not.toContain(cleanupSecret);
    expect(failedRuntime.close).toHaveBeenCalledOnce();
  });

  it("sanitizes combined business and close failures without losing either lifecycle step", async () => {
    const cleanupSecret = "cleanup-database-secret";
    const failedRuntime = runtime({
      prepare: vi.fn(async () => {
        throw new BootstrapAdminError("BOOTSTRAP_ADMIN_TOTP_INVALID");
      }),
      close: vi.fn(async () => {
        throw new Error(`close failed: ${cleanupSecret}`);
      })
    });
    const test = commandOptions({ openRuntime: vi.fn(async () => failedRuntime) });

    await expect(runBootstrapAdminCommand(test.options)).resolves.toBe(1);

    expect(failedRuntime.prepare).toHaveBeenCalledOnce();
    expect(failedRuntime.close).toHaveBeenCalledOnce();
    expect(test.errors).toEqual(["BOOTSTRAP_ADMIN_FAILED"]);
    expect(test.errors).not.toContain("BOOTSTRAP_ADMIN_TOTP_INVALID");
    expect(test.errors.join("\n")).not.toContain(cleanupSecret);
  });

  it("aggregates runtime initialization and pool close failures without leaking either detail", async () => {
    const primary = new Error("service initialization database secret");
    const cleanup = new Error("pool close database secret");
    const pool = { end: vi.fn(async () => { throw cleanup; }) };

    const thrown = await openBootstrapRuntime({ database: {}, keyrings: {} } as never, {
      createPool: vi.fn(() => pool as never),
      createService: vi.fn(() => { throw primary; })
    }).then(() => undefined, (error: unknown) => error);

    expect(thrown).toBeInstanceOf(AggregateError);
    expect([...(thrown as AggregateError).errors]).toEqual([primary, cleanup]);
    expect((thrown as Error).cause).toBe(primary);
    expect((thrown as Error).message).toBe("BOOTSTRAP_ADMIN_RUNTIME_INITIALIZATION_CLEANUP_FAILED");
    expect(pool.end).toHaveBeenCalledOnce();
  });
});
