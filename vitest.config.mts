import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": import.meta.dirname } },
  // tsconfig keeps jsx: "preserve" for Next.js; tests need the automatic runtime instead.
  esbuild: { jsx: "automatic" },
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
});
