import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PlatformSessionContext } from "../../api/identityClient.ts";
import { PlatformRequestError } from "../../api/platformRequest.ts";
import { InvitationAcceptancePage } from "./InvitationAcceptancePage.tsx";
import * as invitationPageExports from "./InvitationAcceptancePage.tsx";
import { MfaChallengePage } from "./MfaChallengePage.tsx";
import { PlatformLoginPage } from "./PlatformLoginPage.tsx";
import { RecoveryCodesPage } from "./RecoveryCodesPage.tsx";
import * as identityAppExports from "./PlatformIdentityApp.tsx";
import {
  createInvitationQrCode,
  createPlatformAccessContext,
  createIdentityOperationRegistry,
  createStrictModeSensitiveDisposal,
  deferIdentityInitialization,
  createSensitivePageLifecycle,
  clearIdentityMemory,
  extractManualTotpSecret,
  focusPlatformError,
  focusPlatformHeading,
  runInvitationPreparation
} from "./PlatformIdentityApp.tsx";

describe("platform identity activation UI", () => {
  it("keeps password login on the MFA path and offers both supported factors", () => {
    const login = renderToStaticMarkup(<PlatformLoginPage busy={false} error="" onSubmit={vi.fn()} />);
    const mfa = renderToStaticMarkup(<MfaChallengePage busy={false} error="" onSubmit={vi.fn()}
      onCancel={vi.fn()} />);

    expect(login).toMatch(/邮箱地址/);
    expect(login).toMatch(/密码/);
    expect(login).not.toMatch(/注册|找回密码|已登录/);
    expect(mfa).toMatch(/身份验证器/);
    expect(mfa).toMatch(/恢复码/);
    expect(mfa).not.toContain("已登录");
  });

  it("gives the authenticator option and its code input distinct accessible names", () => {
    const mfa = renderToStaticMarkup(<MfaChallengePage busy={false} error="" onSubmit={vi.fn()}
      onCancel={vi.fn()} />);

    expect(mfa).toContain('<label for="method-totp"');
    expect(mfa).toContain('<strong id="method-totp-label">身份验证器</strong>');
    expect(mfa).toContain('<small id="method-totp-description">输入 6 位动态验证码</small>');
    expect(mfa).toContain('<label for="platform-mfa-code">6 位动态验证码');
    expect(mfa).not.toContain('<label for="platform-mfa-code">动态验证码</label>');
  });

  it("shows a local QR failure with an actionable manual secret and writes no secret to browser storage or console", async () => {
    const localSet = vi.fn();
    const sessionSet = vi.fn();
    const consoleSpies = ["log", "info", "warn", "error"].map((method) =>
      vi.spyOn(console, method as "log").mockImplementation(() => undefined));
    vi.stubGlobal("localStorage", { setItem: localSet });
    vi.stubGlobal("sessionStorage", { setItem: sessionSet });
    const uri = "otpauth://totp/PDF%20Approval?secret=MANUALKEY123&issuer=PDF";

    await expect(createInvitationQrCode(uri, async () => { throw new Error("encoder secret"); }))
      .resolves.toEqual({ status: "error", message: "二维码生成失败，请使用手工密钥完成设置。" });
    expect(extractManualTotpSecret(uri)).toBe("MANUALKEY123");
    const html = renderToStaticMarkup(<InvitationAcceptancePage
      stage="prepared" busy={false} error="" manualSecret="MANUALKEY123"
      qrCode={{ status: "error", message: "二维码生成失败，请使用手工密钥完成设置。" }}
      onComplete={vi.fn()} onCancel={vi.fn()} />);
    expect(html).toContain("二维码生成失败");
    expect(html).toContain("MANUALKEY123");
    expect(localSet).not.toHaveBeenCalled();
    expect(sessionSet).not.toHaveBeenCalled();
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });

  it("copies the manual secret with explicit ephemeral feedback and no persistence or logging", async () => {
    const copySecret = (invitationPageExports as unknown as {
      copyInvitationSecret?: (secret: string, clipboard?: { writeText(value: string): Promise<void> }) => Promise<{
        status: "success" | "error"; message: string;
      }>;
    }).copyInvitationSecret;
    expect(copySecret).toBeTypeOf("function");
    if (!copySecret) return;
    const writeText = vi.fn(async () => undefined);
    const localSet = vi.fn();
    const sessionSet = vi.fn();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("localStorage", { setItem: localSet });
    vi.stubGlobal("sessionStorage", { setItem: sessionSet });

    await expect(copySecret("MANUAL-SECRET", { writeText })).resolves.toEqual({
      status: "success", message: "密钥已复制，请立即保存到身份验证器。"
    });
    await expect(copySecret("MANUAL-SECRET", undefined)).resolves.toEqual({
      status: "error", message: "当前浏览器无法复制，请手工选择并复制密钥。"
    });
    await expect(copySecret("MANUAL-SECRET", { writeText: async () => { throw new Error("clipboard secret"); } }))
      .resolves.toEqual({ status: "error", message: "复制失败，请手工选择并复制密钥。" });
    expect(writeText).toHaveBeenCalledWith("MANUAL-SECRET");
    expect(localSet).not.toHaveBeenCalled();
    expect(sessionSet).not.toHaveBeenCalled();
    expect(consoleSpy).not.toHaveBeenCalled();

    const prepared = renderToStaticMarkup(<InvitationAcceptancePage stage="prepared" busy={false} error=""
      manualSecret="MANUAL-SECRET" qrCode={{ status: "loading" }} onComplete={vi.fn()} onCancel={vi.fn()} />);
    expect(prepared).toContain("复制密钥");
    expect(prepared).toContain('aria-live="polite"');
    const cleared = renderToStaticMarkup(<InvitationAcceptancePage stage="preparing" busy={false} error=""
      manualSecret="" qrCode={{ status: "loading" }} onComplete={vi.fn()} onCancel={vi.fn()} />);
    expect(cleared).not.toContain("复制密钥");
    expect(cleared).not.toContain("MANUAL-SECRET");
  });

  it("clears sensitive memory on bfcache restoration, disposal and explicit cancellation", () => {
    const clear = vi.fn();
    const lifecycle = createSensitivePageLifecycle(clear);
    lifecycle.handlePageShow({ persisted: false });
    expect(clear).not.toHaveBeenCalled();
    lifecycle.handlePageShow({ persisted: true });
    lifecycle.cancel();
    lifecycle.dispose();
    expect(clear).toHaveBeenCalledTimes(3);
  });

  it("defers unmount clearing across the StrictMode cleanup and immediate remount cycle", async () => {
    const clear = vi.fn();
    const disposal = createStrictModeSensitiveDisposal(clear);
    const firstCleanup = disposal.activate();
    firstCleanup();
    const secondCleanup = disposal.activate();
    await Promise.resolve();
    expect(clear).not.toHaveBeenCalled();
    secondCleanup();
    await Promise.resolve();
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("starts identity initialization only for the live StrictMode effect generation", async () => {
    const stale = new AbortController();
    const current = new AbortController();
    const staleStart = vi.fn();
    const currentStart = vi.fn();
    deferIdentityInitialization(stale.signal, staleStart);
    stale.abort();
    deferIdentityInitialization(current.signal, currentStart);
    await Promise.resolve();
    expect(staleStart).not.toHaveBeenCalled();
    expect(currentStart).toHaveBeenCalledTimes(1);
  });

  it("requires an explicit saved confirmation before recovery codes can be left", () => {
    const html = renderToStaticMarkup(<RecoveryCodesPage recoveryCodes={["RECOVERY-ONE", "RECOVERY-TWO"]}
      acknowledged={false} onAcknowledgedChange={vi.fn()} onContinue={vi.fn()} />);
    expect(html).toContain("RECOVERY-ONE");
    expect(html).toContain("我已将恢复码保存在安全位置");
    expect(html).toMatch(/<button[^>]*disabled/);
    expect(html).toContain("继续登录");
  });

  it("cancelling while invitation prepare is pending aborts ownership and blocks every stale write", async () => {
    const prepare = deferred<{ enrollmentToken: string; otpauthUri: string }>();
    const registry = createIdentityOperationRegistry();
    const onPrepared = vi.fn();
    const onQrCode = vi.fn();
    const onFailed = vi.fn();
    const encodeQr = vi.fn();
    let signal: AbortSignal | undefined;
    const operation = registry.run("invitationPrepare", (lease) => {
      signal = lease.signal;
      return runInvitationPreparation(lease, "invitation-secret", {
        prepare: vi.fn(() => prepare.promise),
        encodeQr
      }, { onPrepared, onQrCode, onFailed });
    });
    const disposeClient = vi.fn();
    const disposeRoute = vi.fn();
    const resetUi = vi.fn();

    clearIdentityMemory({ clearOperations: registry.clear, disposeClient, disposeRoute, resetUi });
    expect(signal?.aborted).toBe(true);
    prepare.resolve({ enrollmentToken: "stale-enrollment", otpauthUri: "otpauth://totp/PDF?secret=STALE" });
    await operation;

    expect(onPrepared).not.toHaveBeenCalled();
    expect(encodeQr).not.toHaveBeenCalled();
    expect(onQrCode).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
    expect(disposeClient).toHaveBeenCalledTimes(1);
    expect(disposeRoute).toHaveBeenCalledTimes(1);
    expect(resetUi).toHaveBeenCalledTimes(1);
  });

  it("bfcache clearing during QR generation prevents the stale QR result or rejection from restoring secrets", async () => {
    const qr = deferred<string>();
    const registry = createIdentityOperationRegistry();
    const writes: string[] = [];
    const onFailed = vi.fn();
    const operation = registry.run("invitationPrepare", (lease) => runInvitationPreparation(lease, "invitation-secret", {
      prepare: vi.fn(async () => ({ enrollmentToken: "enrollment-secret",
        otpauthUri: "otpauth://totp/PDF?secret=MANUALKEY123" })),
      encodeQr: vi.fn(() => qr.promise)
    }, {
      onPrepared: () => writes.push("prepared"),
      onQrCode: () => writes.push("qr"),
      onFailed
    }));
    await Promise.resolve();
    await Promise.resolve();
    expect(writes).toEqual(["prepared"]);

    clearIdentityMemory({ clearOperations: registry.clear, disposeClient: vi.fn(), disposeRoute: vi.fn(),
      resetUi: () => writes.splice(0) });
    qr.resolve("data:image/png;base64,stale");
    await operation;

    expect(writes).toEqual([]);
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("keeps login, MFA and invitation completion independently single-flight from function entry", async () => {
    const registry = createIdentityOperationRegistry();
    const login = deferred<string>();
    const mfa = deferred<string>();
    const invitation = deferred<string>();
    const loginOperation = vi.fn(() => login.promise);
    const mfaOperation = vi.fn(() => mfa.promise);
    const invitationOperation = vi.fn(() => invitation.promise);
    const lateDuplicate = vi.fn(async () => {
      throw new Error("a late duplicate must not run or clear CSRF");
    });

    const loginFirst = registry.run("login", loginOperation);
    const loginDuplicate = registry.run("login", loginOperation);
    const mfaFirst = registry.run("mfa", mfaOperation);
    const mfaDuplicate = registry.run("mfa", lateDuplicate);
    const invitationFirst = registry.run("invitationComplete", invitationOperation);
    const invitationDuplicate = registry.run("invitationComplete", invitationOperation);
    expect(loginOperation).toHaveBeenCalledTimes(1);
    expect(mfaOperation).toHaveBeenCalledTimes(1);
    expect(invitationOperation).toHaveBeenCalledTimes(1);
    expect(lateDuplicate).not.toHaveBeenCalled();

    login.resolve("login");
    mfa.resolve("mfa-session-created");
    invitation.resolve("recovery");
    await expect(Promise.all([loginFirst, loginDuplicate, mfaFirst, mfaDuplicate,
      invitationFirst, invitationDuplicate])).resolves.toEqual([
      "login", "login", "mfa-session-created", "mfa-session-created", "recovery", "recovery"
    ]);
  });

  it("aborts every identity operation generation and ignores all stale resolve or reject handlers", async () => {
    const { createRegistry, runRequest } = requiredIdentityOperationApi();
    const registry = createRegistry();
    const keys = ["sessionLoad", "login", "mfa", "invitationPrepare", "invitationComplete", "logout"] as const;
    const pending = keys.map(() => deferred<string>());
    const signals: AbortSignal[] = [];
    const success = vi.fn();
    const failure = vi.fn();
    const settled = vi.fn();

    const operations = keys.map((key, index) => registry.run(key, (lease) => {
      signals.push(lease.signal);
      return runRequest(lease, () => pending[index]!.promise, {
        onSuccess: (value) => success(key, value),
        onFailure: (error) => failure(key, error),
        onSettled: () => settled(key)
      });
    }));

    registry.clear();
    expect(signals).toHaveLength(keys.length);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    pending[0]!.resolve("stale-session");
    pending[1]!.resolve("stale-challenge");
    pending[2]!.resolve("stale-access-and-csrf");
    pending[3]!.reject(new Error("stale invitation prepare failure"));
    pending[4]!.resolve("stale-recovery-codes");
    pending[5]!.reject(new Error("stale logout failure"));
    await Promise.all(operations);

    expect(success).not.toHaveBeenCalled();
    expect(failure).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
  });

  it("starts a fresh same-key generation while an old finally cannot clear its busy state", async () => {
    const { createRegistry, runRequest } = requiredIdentityOperationApi();
    const registry = createRegistry();
    const stale = deferred<string>();
    const current = deferred<string>();
    const writes: string[] = [];
    let busy = true;
    let staleSignal: AbortSignal | undefined;
    let currentSignal: AbortSignal | undefined;

    const staleOperation = registry.run("login", (lease) => {
      staleSignal = lease.signal;
      return runRequest(lease, () => stale.promise, {
        onSuccess: (value) => writes.push(value),
        onFailure: () => writes.push("stale-error"),
        onSettled: () => { busy = false; }
      });
    });
    const staleDuplicate = registry.run("login", () => Promise.reject(new Error("duplicate must not start")));
    expect(staleDuplicate).toBe(staleOperation);

    registry.clear();
    busy = true;
    const currentOperation = registry.run("login", (lease) => {
      currentSignal = lease.signal;
      return runRequest(lease, () => current.promise, {
        onSuccess: (value) => writes.push(value),
        onFailure: () => writes.push("current-error"),
        onSettled: () => { busy = false; }
      });
    });
    expect(currentOperation).not.toBe(staleOperation);
    expect(staleSignal?.aborted).toBe(true);
    expect(currentSignal?.aborted).toBe(false);

    stale.resolve("stale-challenge");
    await staleOperation;
    expect(writes).toEqual([]);
    expect(busy).toBe(true);

    current.resolve("current-challenge");
    await currentOperation;
    expect(writes).toEqual(["current-challenge"]);
    expect(busy).toBe(false);
  });

  it("atomically invalidates other operations while keeping duplicate logout single-flight", async () => {
    const { createRegistry, runRequest } = requiredIdentityOperationApi();
    const registry = createRegistry();
    const runAfterClear = (registry as TestIdentityOperationRegistry & {
      runAfterClear?<T>(key: "logout", operation: (lease: TestIdentityOperationLease) => Promise<T>): Promise<T>;
    }).runAfterClear;
    expect(runAfterClear).toBeTypeOf("function");
    if (!runAfterClear) return;
    const login = deferred<string>();
    const logout = deferred<string>();
    const deleteSession = vi.fn(() => logout.promise);
    let loginSignal: AbortSignal | undefined;
    let logoutSignal: AbortSignal | undefined;
    let busy = true;

    const staleLogin = registry.run("login", (lease) => {
      loginSignal = lease.signal;
      return runRequest(lease, () => login.promise, {
        onSuccess: vi.fn(), onFailure: vi.fn(), onSettled: () => { busy = false; }
      });
    });
    const firstLogout = runAfterClear.call(registry, "logout", (lease) => {
      logoutSignal = lease.signal;
      return runRequest(lease, deleteSession, {
        onSuccess: vi.fn(), onFailure: vi.fn(), onSettled: () => { busy = false; }
      });
    });
    busy = true;
    const duplicateLogout = runAfterClear.call(registry, "logout", () => Promise.reject(
      new Error("duplicate logout must not start")));

    expect(duplicateLogout).toBe(firstLogout);
    expect(deleteSession).toHaveBeenCalledTimes(1);
    expect(loginSignal?.aborted).toBe(true);
    expect(logoutSignal?.aborted).toBe(false);
    login.resolve("stale-login");
    await staleLogin;
    expect(busy).toBe(true);

    logout.resolve("logged-out");
    await firstLogout;
    expect(busy).toBe(false);
  });

  it("keeps signed-in identity and access after logout network failure, then allows a successful retry", async () => {
    const runLogout = requiredLogoutFlowApi();
    const registry = createIdentityOperationRegistry();
    const first = deferred<void>();
    const retry = deferred<void>();
    const requestLogout = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => retry.promise);
    const identity = { user: "admin", projects: ["project-a"] } as { user?: string; projects: string[] };
    let busy = false;
    let error = "";
    const loggedOut = vi.fn(() => {
      delete identity.user;
      identity.projects = [];
    });
    const sinks = {
      onBusy: (value: boolean) => { busy = value; },
      onError: (value: string) => { error = value; },
      onLoggedOut: loggedOut
    };

    const operation = runLogout(registry, requestLogout, sinks);
    const duplicate = runLogout(registry, requestLogout, sinks);
    expect(duplicate).toBe(operation);
    expect(requestLogout).toHaveBeenCalledTimes(1);
    expect(busy).toBe(true);
    first.reject(new PlatformRequestError(0, "NETWORK_ERROR", "", "Request failed"));
    await operation;
    expect(identity).toEqual({ user: "admin", projects: ["project-a"] });
    expect(loggedOut).not.toHaveBeenCalled();
    expect(error).toBe("退出登录失败，请检查网络连接后重试。");
    expect(busy).toBe(false);

    const retryOperation = runLogout(registry, requestLogout, sinks);
    retry.resolve();
    await retryOperation;
    expect(requestLogout).toHaveBeenCalledTimes(2);
    expect(loggedOut).toHaveBeenCalledTimes(1);
    expect(identity).toEqual({ projects: [] });
    expect(error).toBe("");
  });

  it.each(["success", "sessionInvalid"] as const)("clears identity after logout %s", async (outcome) => {
    const runLogout = requiredLogoutFlowApi();
    const registry = createIdentityOperationRegistry();
    const loggedOut = vi.fn();
    await runLogout(registry, async () => {
      if (outcome === "sessionInvalid") {
        throw new PlatformRequestError(401, "SESSION_INVALID", "request-id", "Request failed");
      }
    }, { onBusy: vi.fn(), onError: vi.fn(), onLoggedOut: loggedOut });
    expect(loggedOut).toHaveBeenCalledTimes(1);
  });

  it("focuses the visible page heading after state changes and the error summary after async failures", () => {
    const heading = { focus: vi.fn() };
    const error = { focus: vi.fn() };
    const root = {
      querySelector: vi.fn((selector: string) => selector === "h1" ? heading :
        selector === '[role="alert"]' ? error : null)
    };

    focusPlatformHeading(root);
    focusPlatformError(root);
    expect(heading.focus).toHaveBeenCalledTimes(1);
    expect(error.focus).toHaveBeenCalledTimes(1);
    expect(root.querySelector).toHaveBeenCalledWith("h1");
    expect(root.querySelector).toHaveBeenCalledWith('[role="alert"]');
  });

  it("makes every identity page heading programmatically focusable", () => {
    const pages = [
      renderToStaticMarkup(<PlatformLoginPage busy={false} error="" onSubmit={vi.fn()} />),
      renderToStaticMarkup(<MfaChallengePage busy={false} error="" onSubmit={vi.fn()} onCancel={vi.fn()} />),
      renderToStaticMarkup(<InvitationAcceptancePage stage="prepared" busy={false} error="" manualSecret="KEY"
        qrCode={{ status: "loading" }} onComplete={vi.fn()} onCancel={vi.fn()} />),
      renderToStaticMarkup(<RecoveryCodesPage recoveryCodes={["CODE"]} acknowledged={false}
        onAcknowledgedChange={vi.fn()} onContinue={vi.fn()} />)
    ];
    for (const html of pages) expect(html).toMatch(/<h1[^>]*tabindex="-1"/i);
  });

  it("derives CSRF-free access data without copying the reducer-owned user", () => {
    const session: PlatformSessionContext = {
      user: {
        id: "01890f1e-9b4a-7cc2-8f00-000000000001", emailNormalized: "admin@example.test",
        displayName: "平台管理员", platformRole: "admin", status: "active", mfaStatus: "enabled",
        mfaEnabledAt: "2026-07-13T00:00:00.000Z", createdAt: "2026-07-13T00:00:00.000Z",
        updatedAt: "2026-07-13T00:00:00.000Z"
      },
      globalCapabilities: ["projects.create"],
      projects: []
    };

    const access = createPlatformAccessContext(session);
    expect(access).toEqual({ globalCapabilities: ["projects.create"], projects: [] });
    expect(access).not.toHaveProperty("user");
    expect(access).not.toHaveProperty("csrfToken");
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

type TestIdentityOperationLease = Readonly<{ signal: AbortSignal; owns(): boolean }>;
type TestIdentityOperationRegistry = Readonly<{
  run<T>(key: string, operation: (lease: TestIdentityOperationLease) => Promise<T>): Promise<T>;
  clear(): void;
}>;

function requiredIdentityOperationApi() {
  const exports = identityAppExports as unknown as {
    createIdentityOperationRegistry?: () => TestIdentityOperationRegistry;
    runOwnedIdentityRequest?: <T>(lease: TestIdentityOperationLease, request: (signal: AbortSignal) => Promise<T>,
      handlers: { onSuccess(value: T): void; onFailure(error: unknown): void; onSettled(): void }) => Promise<void>;
  };
  expect(exports.createIdentityOperationRegistry).toBeTypeOf("function");
  expect(exports.runOwnedIdentityRequest).toBeTypeOf("function");
  return { createRegistry: exports.createIdentityOperationRegistry!, runRequest: exports.runOwnedIdentityRequest! };
}

function requiredLogoutFlowApi() {
  const runLogout = (identityAppExports as unknown as {
    runPlatformLogout?: (registry: ReturnType<typeof createIdentityOperationRegistry>,
      request: (signal: AbortSignal) => Promise<void>, sinks: {
        onBusy(value: boolean): void; onError(value: string): void; onLoggedOut(): void;
      }) => Promise<void>;
  }).runPlatformLogout;
  expect(runLogout).toBeTypeOf("function");
  return runLogout!;
}
