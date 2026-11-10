import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["src/features/wishlist/model.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: ["react", "react/*", "next", "next/*", "node:*"] }],
      "no-restricted-globals": ["error", "fetch", "window", "document", "localStorage", "sessionStorage"],
    },
  },
  globalIgnores([".next/**", "tools/**", "next-env.d.ts", "playwright-report/**", "test-results/**"]),
]);
