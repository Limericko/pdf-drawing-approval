import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export function resolveApiProxyTarget(env: Record<string, string | undefined> = process.env) {
  return env.PDF_APPROVAL_DEV_API_TARGET ?? "http://localhost:8080";
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
      "/api/": apiTarget,
      "/health": apiTarget
    }
  }
});
