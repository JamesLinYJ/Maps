import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: resolve(rootDir, "apps/web"),
  build: {
    outDir: resolve(rootDir, "dist/web"),
    emptyOutDir: true
  },
  test: {
    exclude: ["tests/e2e/**", "node_modules/**"]
  },
  plugins: [react()],
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
