import { describe, expect, it, vi } from "vitest";
import { totpAt } from "../../platform/security/totp.ts";
import { createBootstrapAdminService } from "./bootstrapAdminService.ts";

const passwordHashOptions = { memoryCost: 8192, timeCost: 1, parallelism: 1, outputLen: 32 };
const keyrings = {
  totpEncryption: { currentVersion: "totp-v1", keys: new Map([["totp-v1", Buffer.alloc(32, 1)]]) },
  recoveryHmac: { currentVersion: "recovery-v1", keys: new Map([["recovery-v1", Buffer.alloc(32, 2)]]) }
};
const recoveryCodes = Array.from({ length: 10 }, (_, index) => index.toString(16).padStart(32, "0"));

function schedulerHarness(cancelError?: Error) {
  let callback: (() => void) | undefined;
  let active = false;
  let cancelCount = 0;
  let scheduledDelayMs: number | undefined;

  return {
    scheduler: {
      schedule(next: () => void, delayMs: number) {
        callback = next;
        active = true;
        scheduledDelayMs = delayMs;
        return {
          cancel() {
            if (!active) return;
            active = false;
            cancelCount += 1;
            if (cancelError) throw cancelError;
          }
        };
      }
    },
    fire() {
      if (!active) return;
      active = false;
      callback?.();
    },
    get active() { return active; },
    get cancelCount() { return cancelCount; },
    get scheduledDelayMs() { return scheduledDelayMs; }
  };
}

function observableService(options: {
  throwOnRecoveryHash?: number;
  cancelError?: Error;
  pool?: unknown;
  clock?: () => Date;
} = {}) {
  const scheduler = schedulerHarness(options.cancelError);
  const secret = Buffer.alloc(20, 7);
  const encryptedSecret = Buffer.alloc(49, 8);
  const recoveryHashes: Buffer[] = [];
  let hashCount = 0;
  const service = createBootstrapAdminService({
    pool: (options.pool ?? {}) as never,
    keyrings,
    passwordHashOptions,
    generateTotpSecret: () => secret,
    generateRecoveryCodes: () => [...recoveryCodes],
    encryptSecret: () => ({ keyVersion: "totp-v1", encryptedSecret }),
    hashRecoveryCode: () => {
      hashCount += 1;
      if (hashCount === options.throwOnRecoveryHash) throw new Error("synthetic recovery hash failure");
      const hash = Buffer.alloc(32, hashCount);
      recoveryHashes.push(hash);
      return { keyVersion: "recovery-v1", hash };
    },
    scheduler: scheduler.scheduler,
    clock: options.clock
  });
  return { service, scheduler, secret, encryptedSecret, recoveryHashes };
}

async function prepare(service: ReturnType<typeof createBootstrapAdminService>) {
  return service.prepare({
    email: "admin@example.test",
    displayName: "Administrator",
    password: "correct horse battery staple"
  });
}

function expectCleared(buffer: Buffer) {
  expect(buffer.equals(Buffer.alloc(buffer.length))).toBe(true);
}

function deferredTransactionPool() {
  let releaseAdvisoryLock: (() => void) | undefined;
  let advisoryLockReached!: () => void;
  const reached = new Promise<void>((resolve) => { advisoryLockReached = resolve; });
  const client = {
    async query(text: string) {
      if (text.includes("pg_advisory_xact_lock")) {
        advisoryLockReached();
        await new Promise<void>((resolve) => { releaseAdvisoryLock = resolve; });
      }
      if (text.includes("SELECT EXISTS")) return { rows: [{ exists: false }] } as never;
      if (text.includes("SELECT clock_timestamp() AS now")) {
        return { rows: [{ now: new Date("2026-07-12T15:00:00.000Z") }] } as never;
      }
      if (text.includes("INSERT INTO platform.users")) {
        return { rows: [{
          id: "0198-0000-7000-8000-000000000001",
          email_normalized: "admin@example.test",
          display_name: "Administrator",
          password_hash: "hash",
          platform_role: "admin",
          status: "active",
          mfa_status: "enabled",
          mfa_enabled_at: new Date("2026-07-12T15:00:00.000Z"),
          created_at: new Date("2026-07-12T15:00:00.000Z"),
          updated_at: new Date("2026-07-12T15:00:00.000Z")
        }] } as never;
      }
      return { rows: [], rowCount: 1 } as never;
    },
    release: vi.fn()
  };
  return {
    pool: {
      transactionTimeouts: { queryTimeoutMs: 5_000, lockTimeoutMs: 2_000, transactionTimeoutMs: 10_000 },
      connect: vi.fn(async () => client)
    },
    reached,
    release() { releaseAdvisoryLock?.(); }
  };
}

describe("BootstrapAdminService challenge lifecycle", () => {
  it("unrefs the default expiration timer so an abandoned challenge cannot keep the process alive", async () => {
    const probe = setTimeout(() => undefined, 0);
    const unref = vi.spyOn(Object.getPrototypeOf(probe) as { unref(): unknown }, "unref");
    clearTimeout(probe);
    const service = createBootstrapAdminService({
      pool: {} as never,
      keyrings,
      passwordHashOptions,
      generateRecoveryCodes: () => [...recoveryCodes]
    });

    try {
      const challenge = await prepare(service);
      expect(unref).toHaveBeenCalled();
      challenge.dispose();
    } finally {
      unref.mockRestore();
    }
  });

  it("disposes an abandoned challenge idempotently and rejects later completion", async () => {
    const observed = observableService();
    const challenge = await prepare(observed.service);

    expect(observed.scheduler.scheduledDelayMs).toBe(10 * 60 * 1000);
    expect(() => challenge.dispose()).not.toThrow();
    expect(() => challenge.dispose()).not.toThrow();

    expectCleared(observed.secret);
    expectCleared(observed.encryptedSecret);
    for (const hash of observed.recoveryHashes) expectCleared(hash);
    expect(challenge.otpauthUri).toBe("");
    expect(observed.scheduler.active).toBe(false);
    expect(observed.scheduler.cancelCount).toBe(1);
    await expect(challenge.complete("123456"))
      .rejects.toMatchObject({ code: "BOOTSTRAP_ADMIN_CHALLENGE_USED" });
  });

  it("does not throw or skip secret clearing when expiration cancellation fails", async () => {
    const observed = observableService({ cancelError: new Error("synthetic cancel failure") });
    const challenge = await prepare(observed.service);

    expect(() => challenge.dispose()).not.toThrow();

    expectCleared(observed.secret);
    expectCleared(observed.encryptedSecret);
    for (const hash of observed.recoveryHashes) expectCleared(hash);
    expect(challenge.otpauthUri).toBe("");
  });

  it("automatically disposes an abandoned challenge when its lease expires", async () => {
    const observed = observableService();
    const challenge = await prepare(observed.service);

    observed.scheduler.fire();

    expectCleared(observed.secret);
    expectCleared(observed.encryptedSecret);
    for (const hash of observed.recoveryHashes) expectCleared(hash);
    expect(challenge.otpauthUri).toBe("");
    expect(observed.scheduler.active).toBe(false);
    await expect(challenge.complete("123456"))
      .rejects.toMatchObject({ code: "BOOTSTRAP_ADMIN_CHALLENGE_USED" });
  });

  it("claims completion synchronously, cancels expiry, and clears secrets after validation failure", async () => {
    const observed = observableService();
    const challenge = await prepare(observed.service);

    const first = challenge.complete("not-a-token");

    expect(observed.scheduler.active).toBe(false);
    await expect(first).rejects.toMatchObject({ code: "BOOTSTRAP_ADMIN_TOTP_INVALID" });
    expectCleared(observed.secret);
    expectCleared(observed.encryptedSecret);
    for (const hash of observed.recoveryHashes) expectCleared(hash);
    await expect(challenge.complete("123456"))
      .rejects.toMatchObject({ code: "BOOTSTRAP_ADMIN_CHALLENGE_USED" });
  });

  it("defers disposal while completion is in flight and clears resources after the transaction finishes", async () => {
    const transaction = deferredTransactionPool();
    const now = new Date("2026-07-12T15:00:00.000Z");
    const observed = observableService({ pool: transaction.pool, clock: () => new Date(now) });
    const challenge = await prepare(observed.service);
    const token = totpAt(observed.secret, now.getTime());

    const completing = challenge.complete(token);
    await transaction.reached;
    expect(() => challenge.dispose()).not.toThrow();
    expect(observed.secret.some((value) => value !== 0)).toBe(true);
    expect(observed.encryptedSecret.some((value) => value !== 0)).toBe(true);
    for (const hash of observed.recoveryHashes) {
      expect(hash.some((value) => value !== 0)).toBe(true);
    }

    transaction.release();
    await expect(completing).resolves.toMatchObject({ recoveryCodes: expect.any(Array) });
    expectCleared(observed.secret);
    expectCleared(observed.encryptedSecret);
    for (const hash of observed.recoveryHashes) expectCleared(hash);
    await expect(challenge.complete(token))
      .rejects.toMatchObject({ code: "BOOTSTRAP_ADMIN_CHALLENGE_USED" });
  });

  it("clears partially created resources when preparation fails", async () => {
    const observed = observableService({ throwOnRecoveryHash: 2 });

    await expect(prepare(observed.service)).rejects.toThrow("synthetic recovery hash failure");

    expectCleared(observed.secret);
    expectCleared(observed.encryptedSecret);
    expect(observed.recoveryHashes).toHaveLength(1);
    expectCleared(observed.recoveryHashes[0]!);
    expect(observed.scheduler.active).toBe(false);
  });
});
