import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.integration.test.ts", "e2e/**/*.integration.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000
  }
});
