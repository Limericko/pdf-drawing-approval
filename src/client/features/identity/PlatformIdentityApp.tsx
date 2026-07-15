import { useCallback, useEffect, useRef, useState } from "react";
import {
  completeInvitation,
  completeMfa,
  disposeIdentityClient,
  getSession,
  login,
  logout,
  prepareInvitation,
  type PlatformSessionContext
} from "../../api/identityClient.ts";
import { PlatformRequestError } from "../../api/platformRequest.ts";
import { Button } from "../../ui/actions/index.tsx";
import { InlineAlert } from "../../ui/feedback/index.tsx";
import { currentBrowserIdentityRoute, disposeBrowserIdentityRoute } from "./identityRoutes.ts";
import { initialIdentityState, transitionIdentity, type IdentityEvent, type IdentityState } from "./identityState.ts";
import { InvitationAcceptancePage, type InvitationQrCode } from "./InvitationAcceptancePage.tsx";
import { MfaChallengePage } from "./MfaChallengePage.tsx";
import type { PlatformAccessContext } from "./PlatformAccessPage.tsx";
import { PlatformWorkspace } from "../workspace/PlatformWorkspace.tsx";
import { PlatformLoginPage } from "./PlatformLoginPage.tsx";
import { RecoveryCodesPage } from "./RecoveryCodesPage.tsx";
import { focusPlatformError, focusPlatformHeading } from "./platformFocus.ts";
import { createIdentityOperationRegistry, runOwnedIdentityRequest,
  type IdentityOperationLease } from "./identityOperations.ts";
export { createIdentityOperationRegistry, runOwnedIdentityRequest } from "./identityOperations.ts";
import "./platformIdentity.css";

export { focusPlatformError, focusPlatformHeading } from "./platformFocus.ts";

const qrFailure = Object.freeze({ status: "error" as const,
  message: "二维码生成失败，请使用手工密钥完成设置。" });

export async function runInvitationPreparation<Q>(
  lease: IdentityOperationLease,
  invitationToken: string,
  dependencies: {
    readonly prepare: (invitationToken: string, signal: AbortSignal) => Promise<{
      readonly enrollmentToken: string;
      readonly otpauthUri: string;
    }>;
    readonly encodeQr: (otpauthUri: string) => Promise<Q>;
  },
  sinks: {
    readonly onPrepared: (prepared: { readonly enrollmentToken: string; readonly otpauthUri: string }) => void;
    readonly onQrCode: (qrCode: Q) => void;
    readonly onFailed: () => void;
  }
) {
  try {
    const prepared = await dependencies.prepare(invitationToken, lease.signal);
    if (!lease.owns()) return;
    sinks.onPrepared(prepared);
    const qrCode = await dependencies.encodeQr(prepared.otpauthUri);
    if (!lease.owns()) return;
    sinks.onQrCode(qrCode);
  } catch {
    if (lease.owns()) sinks.onFailed();
  }
}

export function clearIdentityMemory(dependencies: {
  readonly clearOperations: () => void;
  readonly disposeClient: () => void;
  readonly disposeRoute: () => void;
  readonly resetUi: () => void;
}) {
  dependencies.clearOperations();
  dependencies.disposeClient();
  dependencies.disposeRoute();
  dependencies.resetUi();
}

export function createPlatformAccessContext(session: PlatformSessionContext): PlatformAccessContext {
  return { globalCapabilities: session.globalCapabilities, projects: session.projects };
}

export function runPlatformLogout(
  registry: ReturnType<typeof createIdentityOperationRegistry>,
  requestLogout: (signal: AbortSignal) => Promise<void>,
  sinks: {
    readonly onBusy: (value: boolean) => void;
    readonly onError: (value: string) => void;
    readonly onLoggedOut: () => void;
  }
) {
  return registry.runAfterClear("logout", (lease) => {
    sinks.onBusy(true);
    sinks.onError("");
    return runOwnedIdentityRequest(lease, requestLogout, {
      onSuccess: sinks.onLoggedOut,
      onFailure: (failure) => {
        if (failure instanceof PlatformRequestError && failure.status === 401 && failure.code === "SESSION_INVALID") {
          sinks.onLoggedOut();
        } else {
          sinks.onError("退出登录失败，请检查网络连接后重试。");
        }
      },
      onSettled: () => sinks.onBusy(false)
    });
  });
}

export async function createInvitationQrCode(
  otpauthUri: string,
  encoder: (value: string) => Promise<string> = async (value) => {
    const { default: QRCode } = await import("qrcode");
    return QRCode.toDataURL(value, {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 220
    });
  }
): Promise<InvitationQrCode> {
  try {
    const dataUrl = await encoder(otpauthUri);
    return dataUrl.startsWith("data:image/") ? { status: "ready", dataUrl } : qrFailure;
  } catch {
    return qrFailure;
  }
}

export function extractManualTotpSecret(otpauthUri: string) {
  try {
    const url = new URL(otpauthUri);
    if (url.protocol !== "otpauth:" || url.hostname !== "totp") return "";
    return url.searchParams.get("secret")?.trim() ?? "";
  } catch {
    return "";
  }
}

export function createSensitivePageLifecycle(clear: () => void) {
  return Object.freeze({
    handlePageShow(event: { readonly persisted: boolean }) {
      if (event.persisted) clear();
    },
    cancel: clear,
    dispose: clear
  });
}

export function createStrictModeSensitiveDisposal(clear: () => void) {
  let version = 0;
  return Object.freeze({
    activate() {
      const activeVersion = ++version;
      return () => queueMicrotask(() => {
        if (version === activeVersion) clear();
      });
    }
  });
}

export function deferIdentityInitialization(signal: AbortSignal, start: () => void) {
  queueMicrotask(() => {
    if (!signal.aborted) start();
  });
}

export function PlatformIdentityApp() {
  const [state, setState] = useState<IdentityState>(initialIdentityState);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [qrCode, setQrCode] = useState<InvitationQrCode>({ status: "loading" });
  const [recoveryAcknowledged, setRecoveryAcknowledged] = useState(false);
  const [accessContext, setAccessContext] = useState<PlatformAccessContext>();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const identityOperations = useRef<ReturnType<typeof createIdentityOperationRegistry> | undefined>(undefined);
  if (!identityOperations.current) identityOperations.current = createIdentityOperationRegistry();

  const dispatch = useCallback((event: IdentityEvent) => {
    setState((current) => transitionIdentity(current, event));
  }, []);

  const clearMemory = useCallback(() => clearIdentityMemory({
    clearOperations: identityOperations.current!.clear,
    disposeClient: disposeIdentityClient,
    disposeRoute: disposeBrowserIdentityRoute,
    resetUi: () => {
      setQrCode({ status: "loading" });
      setRecoveryAcknowledged(false);
      setAccessContext(undefined);
      setBusy(false);
      setError("");
    }
  }), []);

  const clearSensitive = useCallback(() => {
    clearMemory();
    dispatch({ type: "disposed" });
  }, [clearMemory, dispatch]);

  const enterFatal = useCallback((code: string) => {
    clearMemory();
    dispatch({ type: "failed", code });
  }, [clearMemory, dispatch]);
  const sensitiveDisposal = useRef<ReturnType<typeof createStrictModeSensitiveDisposal> | undefined>(undefined);
  if (!sensitiveDisposal.current) sensitiveDisposal.current = createStrictModeSensitiveDisposal(clearSensitive);

  useEffect(() => {
    const abort = new AbortController();
    deferIdentityInitialization(abort.signal, () => {
      const route = currentBrowserIdentityRoute();
      if (route.name === "acceptInvitation") {
        dispatch({ type: "invitationFound", invitationToken: route.invitationToken });
        void identityOperations.current!.run("invitationPrepare", (lease) =>
          runInvitationPreparation(lease, route.invitationToken, {
            prepare: (invitationToken, signal) => prepareInvitation({ invitationToken }, signal),
            encodeQr: createInvitationQrCode
          }, {
            onPrepared: (prepared) => dispatch({ type: "invitationPrepared",
              enrollmentToken: prepared.enrollmentToken, otpauthUri: prepared.otpauthUri }),
            onQrCode: setQrCode,
            onFailed: () => enterFatal("INVITATION_PREPARE_FAILED")
          }));
      } else if (route.name === "invalid") {
        enterFatal(route.code);
      } else {
        void identityOperations.current!.run("sessionLoad", (lease) => runOwnedIdentityRequest(lease,
          (signal) => getSession(signal), {
          onSuccess: (session) => {
            setAccessContext(createPlatformAccessContext(session));
            dispatch({ type: "sessionLoaded", session });
          },
          onFailure: (failure) => {
            if (failure instanceof PlatformRequestError && failure.status === 401) dispatch({ type: "sessionMissing" });
            else enterFatal("SESSION_LOAD_FAILED");
          },
          onSettled: () => undefined
        }));
      }
    });
    return () => abort.abort();
  }, [dispatch, enterFatal]);

  useEffect(() => {
    const lifecycle = createSensitivePageLifecycle(clearSensitive);
    const scheduleDisposal = sensitiveDisposal.current!.activate();
    const handlePageShow = (event: PageTransitionEvent) => lifecycle.handlePageShow(event);
    addEventListener("pageshow", handlePageShow);
    return () => {
      removeEventListener("pageshow", handlePageShow);
      scheduleDisposal();
    };
  }, [clearSensitive]);

  useEffect(() => {
    focusPlatformHeading(surfaceRef.current);
  }, [state.status]);

  useEffect(() => {
    if (error || qrCode.status === "error") focusPlatformError(surfaceRef.current);
  }, [error, qrCode.status]);

  async function submitLogin(input: Parameters<typeof login>[0]) {
    return identityOperations.current!.run("login", (lease) => {
      setBusy(true);
      setError("");
      return runOwnedIdentityRequest(lease, (signal) => login(input, signal), {
        onSuccess: (challenge) => {
          dispatch({ type: "loginChallenge", challengeToken: challenge.challengeToken });
        },
        onFailure: () => setError("邮箱或密码无效，请重新输入。"),
        onSettled: () => setBusy(false)
      });
    });
  }

  async function submitMfa(factor: Parameters<typeof completeMfa>[0]["factor"]) {
    return identityOperations.current!.run("mfa", async (lease) => {
      if (state.status !== "mfaChallenge") return;
      const challengeToken = state.challengeToken;
      setBusy(true);
      setError("");
      await runOwnedIdentityRequest(lease, (signal) => completeMfa({ challengeToken, factor }, signal), {
        onSuccess: (session) => {
          setAccessContext(createPlatformAccessContext(session));
          dispatch({ type: "mfaCompleted", session });
        },
        onFailure: () => setError("验证码或恢复码无效，请重试。"),
        onSettled: () => setBusy(false)
      });
    });
  }

  async function submitInvitation(input: { readonly password: string; readonly totp: string }) {
    return identityOperations.current!.run("invitationComplete", async (lease) => {
      if (state.status !== "acceptingInvitation" || !state.enrollmentToken) return;
      const enrollmentToken = state.enrollmentToken;
      setBusy(true);
      setError("");
      await runOwnedIdentityRequest(lease,
        (signal) => completeInvitation({ enrollmentToken, ...input }, signal), {
        onSuccess: (result) => {
          clearMemory();
          dispatch({ type: "invitationCompleted", recoveryCodes: result.recoveryCodes });
        },
        onFailure: () => setError("激活失败，请检查密码和动态验证码后重试。"),
        onSettled: () => setBusy(false)
      });
    });
  }

  function cancelSensitiveFlow() {
    clearSensitive();
  }

  async function signOut() {
    return runPlatformLogout(identityOperations.current!, logout, {
      onBusy: setBusy,
      onError: setError,
      onLoggedOut: () => {
        clearMemory();
        dispatch({ type: "loggedOut" });
      }
    });
  }

  if (state.status === "signedIn" && accessContext) {
    return <PlatformWorkspace user={state.user} context={accessContext} logoutBusy={busy}
      logoutError={error} onLogout={signOut} />;
  }

  return <PlatformFrame step={stepForState(state)} surfaceRef={surfaceRef}>
    {state.status === "loading" ? <div className="platform-panel platform-panel--narrow" aria-busy="true">
      <p className="platform-kicker">安全入口</p><h1 tabIndex={-1}>正在确认身份</h1><p>请稍候，正在读取安全会话。</p></div> : null}
    {state.status === "signedOut" ? <PlatformLoginPage busy={busy} error={error} onSubmit={submitLogin} /> : null}
    {state.status === "mfaChallenge" ? <MfaChallengePage busy={busy} error={error}
      onSubmit={submitMfa} onCancel={cancelSensitiveFlow} /> : null}
    {state.status === "acceptingInvitation" ? <InvitationAcceptancePage
      stage={state.enrollmentToken ? "prepared" : "preparing"} busy={busy} error={error}
      manualSecret={state.otpauthUri ? extractManualTotpSecret(state.otpauthUri) : ""}
      qrCode={qrCode} onComplete={submitInvitation} onCancel={cancelSensitiveFlow} /> : null}
    {state.status === "showingRecoveryCodes" ? <RecoveryCodesPage recoveryCodes={state.recoveryCodes}
      acknowledged={recoveryAcknowledged} onAcknowledgedChange={setRecoveryAcknowledged}
      onContinue={() => recoveryAcknowledged && dispatch({ type: "recoveryCodesAcknowledged" })} /> : null}
    {state.status === "fatalError" ? <div className="platform-panel platform-panel--narrow">
      <p className="platform-kicker">安全入口</p><h1 tabIndex={-1}>暂时无法继续</h1>
      <InlineAlert tone="danger">安全流程未能完成。请刷新页面重试，持续失败时联系管理员。</InlineAlert>
      <Button onClick={() => location.reload()}>刷新页面</Button>
    </div> : null}
  </PlatformFrame>;
}

function stepForState(state: IdentityState) {
  if (state.status === "signedIn") return 3;
  if (["mfaChallenge", "acceptingInvitation", "showingRecoveryCodes"].includes(state.status)) return 2;
  return 1;
}

function PlatformFrame({ step, surfaceRef, children }: { readonly step: number;
  readonly surfaceRef: React.RefObject<HTMLDivElement | null>; readonly children: React.ReactNode }) {
  return <main className="platform-identity" data-runtime-mode="platform">
    <header className="platform-topbar"><div className="platform-brand"><span aria-hidden="true">P</span>
      <strong>PDF 审批平台</strong></div><span>安全访问</span></header>
    <div className="platform-workspace">
      <ol className="platform-steps" aria-label="安全访问进度">
        {["验证身份", "安全确认", "项目访问"].map((label, index) => <li key={label}
          className={step === index + 1 ? "is-current" : step > index + 1 ? "is-complete" : ""}
          aria-current={step === index + 1 ? "step" : undefined}>
          <span>0{index + 1}</span><strong>{label}</strong></li>)}
      </ol>
      <div className="platform-surface" ref={surfaceRef}>{children}</div>
    </div>
  </main>;
}
