import { defineConfig, devices } from "@playwright/test";
import { generateVAPIDKeys } from "web-push";

/**
 * ISOLATED browser E2E: the real UI, real route handlers and real validation against an
 * in-memory copy of the four spreadsheet tabs (SHEETS_TEST_BACKEND=memory). It has no Google
 * credentials at all, so it can never read or write any spreadsheet. Time is simulated by seeding
 * timestamps through the guarded test seed route (no waiting 7 days).
 *
 *   npm run test:e2e:isolated
 */
const PORT = 3102;
// Throwaway VAPID keys for this run only (never real ones).
const VAPID = generateVAPIDKeys();
export const SEED_KEY = "e2e-isolated-seed-key";

/** The six viewport sizes the product must support. */
export const VIEWPORTS = [
  { name: "mobile-320x568", viewport: { width: 320, height: 568 }, mobile: true },
  { name: "mobile-375x812", viewport: { width: 375, height: 812 }, mobile: true },
  { name: "mobile-430x932", viewport: { width: 430, height: 932 }, mobile: true },
  { name: "tablet-768x1024", viewport: { width: 768, height: 1024 }, mobile: true },
  { name: "laptop-1366x768", viewport: { width: 1366, height: 768 }, mobile: false },
  { name: "desktop-1920x1080", viewport: { width: 1920, height: 1080 }, mobile: false },
] as const;

export default defineConfig({
  testDir: "tests/e2e-isolated",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  timeout: 60_000,
  use: { baseURL: `http://localhost:${PORT}`, extraHTTPHeaders: { "x-test-key": SEED_KEY } },
  webServer: {
    command: `npm run dev -- --port ${PORT}`,
    url: `http://localhost:${PORT}/login`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      SHEETS_TEST_BACKEND: "memory",
      TEST_SEED_KEY: SEED_KEY,
      // No Google access of any kind in this suite.
      GOOGLE_SHEETS_SPREADSHEET_ID: "",
      GOOGLE_SERVICE_ACCOUNT_EMAIL: "",
      GOOGLE_PRIVATE_KEY: "",
      SHEETS_CACHE_TTL_MS: "0",
      VAPID_PUBLIC_KEY: VAPID.publicKey,
      VAPID_PRIVATE_KEY: VAPID.privateKey,
      CRON_SECRET: "e2e-cron-secret",
      NEXT_PUBLIC_AUTO_REFRESH_MS: "2500",
      NEXT_DIST_DIR: ".next-e2e-isolated",
      APP_TIMEZONE: "Asia/Kolkata",
    },
  },
  projects: [
    { name: "workflow-desktop", testMatch: /(workflow|notifications|connections)\.spec\.ts/, use: { ...devices["Desktop Chrome"], viewport: { width: 1366, height: 768 } } },
    { name: "workflow-mobile", testMatch: /(workflow|notifications|connections)\.spec\.ts/, use: { ...devices["Pixel 7"] } },
    // Group chat: several browser contexts (one per member), real WebRTC between them using Chromium's fake camera/microphone.
    {
      name: "chat-desktop",
      testMatch: /chat\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1366, height: 768 }, launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] } },
    },
    ...VIEWPORTS.map((v) => ({
      name: `responsive-${v.name}`,
      testMatch: /responsive\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], viewport: v.viewport, isMobile: v.mobile, hasTouch: v.mobile, deviceScaleFactor: v.mobile ? 2 : 1 },
    })),
  ],
});
