import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: { baseURL: `http://localhost:${PORT}` },
  webServer: {
    command: `npm run dev -- --port ${PORT}`,
    url: `http://localhost:${PORT}/login`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      // E2E must NEVER touch the real spreadsheet. Empty values (which .env.local cannot override)
      // keep Google Sheets unconfigured, so data routes return their safe 503 and pages show the
      // error state. Data behaviour is covered by the mocked unit/integration tests.
      GOOGLE_SHEETS_SPREADSHEET_ID: "",
      GOOGLE_SERVICE_ACCOUNT_EMAIL: "",
      GOOGLE_PRIVATE_KEY: "",
      NEXT_DIST_DIR: ".next-e2e",
    },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
});
