import { expect, test, type Page } from "@playwright/test";
import { appendRows, horizontalOverflow, jobRow, resetStore, signIn } from "./helpers";

/**
 * Notification onboarding and deep links in a real Chromium, against the isolated in-memory backend.
 * Real push DELIVERY needs Google's push service and a real device, so it is NOT covered here (see docs/testing).
 */
const ONBOARDING = "Enable notifications to know immediately when Anni, Lukky, or Rishii adds a job or applies for one.";

/** Counts calls to the native permission prompt and optionally forces a permission state. */
async function instrument(page: Page, opts: { permission?: "denied" | "default"; noPush?: boolean } = {}) {
  await page.addInitScript((o) => {
    const w = window as unknown as { __prompts: number };
    w.__prompts = 0;
    const real = Notification.requestPermission.bind(Notification);
    Notification.requestPermission = (...args: Parameters<typeof real>) => {
      w.__prompts += 1;
      return o.permission === "denied" ? Promise.resolve("denied" as NotificationPermission) : real(...args);
    };
    if (o.permission) Object.defineProperty(Notification, "permission", { get: () => o.permission, configurable: true });
    if (o.noPush) delete (window as unknown as Record<string, unknown>).PushManager;
  }, opts);
}
const prompts = (page: Page) => page.evaluate(() => (window as unknown as { __prompts: number }).__prompts);

test.beforeEach(async ({ request }) => {
  await resetStore(request);
});

test("default permission: the onboarding dialog appears on the first Dashboard visit and never prompts by itself", async ({ page }) => {
  await instrument(page, { permission: "default" });
  await signIn(page, "Anni", "0001", { keepNotificationOnboarding: true });
  const dialog = page.getByRole("dialog", { name: "Turn on notifications" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(ONBOARDING)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Enable Notifications" })).toBeVisible();
  expect(await prompts(page)).toBe(0);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  const box = await dialog.boundingBox();
  const vp = page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(vp.height);
});

test("'Not now' closes it, the Dashboard is usable, and it does not come back this session (no loop)", async ({ page }) => {
  await instrument(page, { permission: "default" });
  await signIn(page, "Lukky", "0002", { keepNotificationOnboarding: true });
  await page.getByRole("button", { name: "Not now" }).click();
  await expect(page.getByRole("dialog", { name: "Turn on notifications" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /Welcome back, Lukky/ })).toBeVisible();
  await page.goto("/all-jobs");
  await page.goto("/dashboard");
  await page.reload();
  await expect(page.getByRole("heading", { name: /Welcome back, Lukky/ })).toBeVisible();
  await expect(page.getByTestId("notification-onboarding")).toHaveCount(0);
  expect(await prompts(page)).toBe(0);
});

test("Escape and the close button also dismiss it", async ({ page }) => {
  await instrument(page, { permission: "default" });
  await signIn(page, "Rishii", "0003", { keepNotificationOnboarding: true });
  await expect(page.getByTestId("notification-onboarding")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("notification-onboarding")).toHaveCount(0);
});

test("denied permission: explains how to unblock Chrome notifications and never re-prompts", async ({ page }) => {
  await instrument(page, { permission: "denied" });
  await signIn(page, "Anni", "0001", { keepNotificationOnboarding: true });
  const dialog = page.getByRole("dialog", { name: "Notifications are blocked" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/Chrome has blocked notifications for JobSync/)).toBeVisible();
  await expect(dialog.getByText(/Site settings/).first()).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Enable Notifications" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Check again" }).click();
  await expect(dialog).toBeVisible(); // still blocked: stays informational, no prompt
  await dialog.getByRole("button", { name: "Close", exact: true }).last().click();
  await expect(dialog).toHaveCount(0);
  expect(await prompts(page)).toBe(0);
});

test("clicking Enable asks the browser exactly once; a blocked answer switches to the instructions", async ({ page }) => {
  await instrument(page, { permission: "default" });
  // Simulate the member choosing "Block" in Chrome's own prompt.
  await page.addInitScript(() => {
    const w = window as unknown as { __prompts: number };
    Notification.requestPermission = () => {
      w.__prompts += 1;
      Object.defineProperty(Notification, "permission", { get: () => "denied", configurable: true });
      return Promise.resolve("denied" as NotificationPermission);
    };
  });
  await signIn(page, "Anni", "0001", { keepNotificationOnboarding: true });
  await page.getByRole("button", { name: "Enable Notifications" }).click();
  await expect(page.getByText(/Chrome has blocked notifications for JobSync/)).toBeVisible();
  expect(await prompts(page)).toBe(1);
});

test("unsupported browser: says push is unavailable", async ({ page }) => {
  await instrument(page, { noPush: true });
  await signIn(page, "Anni", "0001", { keepNotificationOnboarding: true });
  await expect(page.getByText(/doesn’t support push notifications/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Enable Notifications" })).toHaveCount(0);
});

test("the onboarding appears only on the Dashboard, not on other pages", async ({ page }) => {
  await instrument(page, { permission: "default" });
  await signIn(page, "Anni", "0001", { keepNotificationOnboarding: true });
  await page.getByRole("button", { name: "Not now" }).click();
  await page.goto("/all-jobs");
  await expect(page.getByTestId("notification-onboarding")).toHaveCount(0);
});

test("the service worker is served from the site root as JavaScript, uncached", async ({ request }) => {
  const res = await request.get("/sw.js");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toMatch(/javascript/);
  expect(res.headers()["cache-control"]).toMatch(/no-cache|no-store/);
  const body = await res.text();
  expect(body).toContain("notificationclick");
  expect(body).toContain("showNotification");
});

test("a notification link opens the right job's details", async ({ page, request }) => {
  await appendRows(request, "Jobs", [jobRow(1, { role: "Platform Engineer", company: "Deep Link Co", by: "lukky" }), jobRow(2, { role: "Other Role" })]);
  await signIn(page, "Anni", "0001");
  await page.goto("/all-jobs?job=job_e2e1");
  const details = page.getByRole("dialog");
  await expect(details).toBeVisible();
  await expect(details).toContainText("Platform Engineer");
  await expect(details).toContainText("Deep Link Co");
});

test("a notification link to an unknown or malformed job simply shows All Jobs", async ({ page, request }) => {
  await appendRows(request, "Jobs", [jobRow(1)]);
  await signIn(page, "Anni", "0001");
  for (const id of ["job_missing", "../../x", "%3Cscript%3E"]) {
    await page.goto(`/all-jobs?job=${id}`);
    await expect(page.getByRole("heading", { name: "All Jobs" }).first()).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
});

test("protected push endpoints reject anonymous callers", async ({ request }) => {
  expect((await request.get("/api/push/config")).status()).toBe(401);
  expect((await request.post("/api/push/subscriptions", { data: {} })).status()).toBe(401);
  expect((await request.get("/api/cron/daily-notifications?slot=morning")).status()).toBe(401);
});
