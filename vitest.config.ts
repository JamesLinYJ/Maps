import { defineConfig } from "vitest/config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    setupFiles: ["./apps/web/src/test-setup.ts"]
  },
  resolve: {
    alias: {
      "@maps/api": resolve(rootDir, "apps/api/src"),
      "@maps/compliance": resolve(rootDir, "packages/compliance/src/index.ts"),
      "@maps/llm-core": resolve(rootDir, "packages/llm-core/src/index.ts"),
      "@maps/map-core": resolve(rootDir, "packages/map-core/src/index.ts"),
      "@maps/observability": resolve(rootDir, "packages/observability/src/index.ts"),
      "@maps/schemas": resolve(rootDir, "packages/schemas/src/index.ts"),
      "@maps/tools": resolve(rootDir, "packages/tools/src/index.ts"),
      "@maps/ui": resolve(rootDir, "packages/ui/src/index.tsx"),
      "@maps/voice-core": resolve(rootDir, "packages/voice-core/src/index.ts")
    }
  }
});
