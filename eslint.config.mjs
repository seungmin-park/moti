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
      "src/features/wishlist/product-fields.ts",
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
      // after() and cookies are handed in by the assembly in src/app/_server, never reached for here.
      "no-restricted-imports": ["error", { patterns: ["@supabase/*", "pg", "**/infrastructure/**", "next/server", "next/headers"] }],
    },
  },
  {
    files: ["src/features/wishlist/**/*.tsx"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [
        "**/server/**", "@supabase/*", "pg", "node:*", "**/screen/**", "**/library/**", "**/auth/**",
      ] }],
    },
  },
  {
    files: ["src/features/*/screen/**/*.{ts,tsx}"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [
        {
          group: ["@supabase/*", "pg", "node:*", "next/headers", "next/server", "server-only"],
          message: "화면은 API 계약만 쓰는 HTTP 클라이언트다.",
        },
        { regex: "(^|/)(application|domain|infrastructure)(/|$)", message: "화면은 내부 계층을 가져오지 않는다." },
        { regex: "/presentation/(?!(library-dto|library-backup|login-error|share-dto)$)", message: "공개 계약만 가져온다." },
        { regex: "(^@/app/|/_server/)", message: "조립 위치(Route Handler)에 의존하지 않는다." },
        {
          regex: "/wishlist/(?!(link|collection-name|product-fields|CollectionPicker|Dialog)$)",
          message: "목업 상태·예시 데이터·예시 가격을 실제 화면에 들이지 않는다.",
        },
      ] }],
    },
  },
  {
    files: ["src/app/_server/share-context.ts", "src/app/api/share/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [
        {
          group: ["next/headers", "@supabase/ssr", "**/_server/context", "./context"],
          message: "단축어 요청은 쿠키를 읽지도 쓰지도 않는다. 키만 인증이다.",
        },
      ] }],
    },
  },
  {
    files: ["src/app/**/page.tsx"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [
        "@supabase/*", "pg", "**/infrastructure/**", "**/application/**", "**/_server/**",
      ] }],
    },
  },
  globalIgnores([
    ".next/**", "tools/**", "next-env.d.ts", "playwright-report/**", "test-results/**",
    "playwright-report-database/**", "test-results-database/**",
  ]),
]);
