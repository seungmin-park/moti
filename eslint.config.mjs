import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: [
      "src/features/wishlist/model.ts",
      "src/features/wishlist/link.ts",
      "src/features/wishlist/collection-name.ts",
      "src/features/*/domain/**/*.ts",
    ],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [
        "react", "react/*", "next", "next/*", "node:*", "@supabase/*", "pg", "zod",
        "**/application/**", "**/infrastructure/**", "**/presentation/**",
      ] }],
      "no-restricted-globals": ["error", "fetch", "window", "document", "localStorage", "sessionStorage"],
    },
  },
  {
    files: ["src/features/*/application/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [
        "react", "react/*", "next", "next/*", "node:*", "@supabase/*", "pg",
        "**/infrastructure/**", "**/presentation/**",
      ] }],
    },
  },
  {
    files: ["src/features/*/infrastructure/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: ["react", "react/*", "next", "next/*", "**/presentation/**"] }],
    },
  },
  {
    files: ["src/features/*/presentation/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: ["@supabase/*", "pg", "**/infrastructure/**"] }],
    },
  },
  {
    files: ["src/features/wishlist/**/*.tsx"],
    rules: {
      "no-restricted-imports": ["error", { patterns: ["**/server/**", "@supabase/*", "pg", "node:*"] }],
    },
  },
  globalIgnores([".next/**", "tools/**", "next-env.d.ts", "playwright-report/**", "test-results/**"]),
]);
