export type RuntimeMode = "legacy" | "platform";

export function resolveRuntimeMode(env: NodeJS.ProcessEnv): RuntimeMode {
  const runtimeMode = env.PDF_APPROVAL_RUNTIME_MODE?.trim() || "legacy";
  if (runtimeMode !== "legacy" && runtimeMode !== "platform") {
    throw new Error("INVALID_RUNTIME_MODE");
  }
  return runtimeMode;
}
