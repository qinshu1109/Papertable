import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  forbidOnly: Boolean(process.env.CI),
  use: { baseURL: "http://127.0.0.1:5174", trace: "retain-on-failure" },
  webServer: {
    command: `${process.execPath} server/e2e.mjs`,
    url: "http://127.0.0.1:5174",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
