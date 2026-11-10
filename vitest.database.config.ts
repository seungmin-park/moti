import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/persistence/**/*.test.ts", "tests/service/**/*.test.ts", "tests/http/**/*.test.ts"],
    environment: "node",
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 15000,
    hookTimeout: 15000,
    passWithNoTests: false,
  },
});
