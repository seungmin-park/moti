import { defineConfig, devices, type ReporterDescription } from "@playwright/test";
import { HTTP_APP_PORT } from "./tests/support/database-config";

const report = process.env.MOTI_BROWSER_REPORT;
const reporter: ReporterDescription[] = [
  ["list"],
  ["html", { open: "never", outputFolder: "playwright-report-database" }],
  ...(report ? [["json", { outputFile: report }] satisfies ReporterDescription] : []),
];

export default defineConfig({
  testDir: "tests/browser",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 60_000,
  outputDir: "test-results-database",
  reporter,
  use: {
    baseURL: `http://127.0.0.1:${HTTP_APP_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "iphone-webkit", use: { ...devices["iPhone 13"] } },
  ],
});
