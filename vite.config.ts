import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export function resolveApiProxyTarget(env: Record<string, string | undefined> = process.env) {
  if (env.PDF_APPROVAL_VITE_TARGET === "platform-e2e") {
    const target = env.PDF_APPROVAL_PLATFORM_TEST_API_TARGET?.trim();
    if (!target) throw new Error("PLATFORM_E2E_API_TARGET_MISSING");
    return target;
  }
  return env.PDF_APPROVAL_DEV_API_TARGET ?? "http://localhost:8080";
}

export function bypassFrontendApiSourceProxy(requestUrl: string | undefined) {
  if (!requestUrl) return undefined;
  const queryIndex = requestUrl.indexOf("?");
  const rawPathname = queryIndex === -1 ? requestUrl : requestUrl.slice(0, queryIndex);
  const rawQuery = queryIndex === -1 ? "" : requestUrl.slice(queryIndex);
  if (!/^(?:|\?import|\?t=\d+|\?import&t=\d+|\?t=\d+&import)$/.test(rawQuery)) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(requestUrl, "http://vite.local");
  } catch {
    return undefined;
  }
  const pathname = parsed.pathname;
  if (parsed.origin !== "http://vite.local" || parsed.hash || pathname !== rawPathname ||
      pathname.startsWith("/api/v2") || pathname.includes("%") ||
      !/^\/api\/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:ts|tsx)$/.test(pathname)) {
    return undefined;
  }
  return requestUrl;
}

const apiTarget = resolveApiProxyTarget();

export default defineConfig({
  plugins: [react()],
  root: "src/client",
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true
  },
  server: {
    proxy: {
      "/api/": {
        target: apiTarget,
        bypass: (request) => bypassFrontendApiSourceProxy(request.url)
      },
      "/health": apiTarget
    }
  }
});
