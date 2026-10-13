import { expect, test, type Page } from "@playwright/test";
import { appendRows, dataRows, horizontalOverflow, installFakePush, jobRow, resetStore, signIn, type FakePushOptions } from "./helpers";

/**
 * Mandatory notification gate, in real Chromium against the isolated in-memory backend. The browser's Web Push stack
 * is a scriptable fake (headless Chromium has no push service); the server side is the real application.
 * Real push DELIVERY to a device is NOT covered here (see docs/testing).
 */
const ONBOARDING = "Enable notifications to know immediately when Anni, Lukky, or Rishii adds a job or applies for one.";
const PROTECTED = ["/dashboard", "/all-jobs", "/my-applications", "/add-job", "/analytics"];

const gate = (page: Page) => page.locator("[data-notification-gate]");
const dialog = (page: Page) => page.getByTestId("notification-onboarding");
const push = (page: Page) => page.evaluate(() => { const p = (window as unknown as { __push: { prompts: number; subscribes: number } }).__push; return { prompts: p.prompts, subscribes: p.subscribes }; });
const login = (page: Page, push: FakePushOptions, who: [string, string] = ["Anni", "0001"]) => signIn(page, who[0], who[1], { push });
const setPush = (page: Page, fn: string) => page.evaluate(fn);

test.beforeEach(async ({ request }) => {
  await resetStore(request);
});

test("default permission: the whole app is blurred and blocked behind the notification dialog, and nothing prompts by itself", async ({ page }) => {
  await login(page, { permission: "default" });
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByText(ONBOARDING)).toBeVisible();
  await expect(gate(page)).toHaveAttribute("data-notification-gate", "blocked");
  await expect(gate(page)).toHaveAttribute("inert", "");
  expect(await gate(page).evaluate((el) => getComputedStyle(el).filter)).toContain("blur");
  // the dashboard behind it cannot be reached (not focusable, not in the accessibility tree)
  await expect(page.getByRole("link", { name: "All Jobs", exact: true })).toHaveCount(0);
  expect((await push(page)).prompts).toBe(0);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  const box = (await dialog(page).boundingBox())!;
  const vp = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height);
});

test("Not now: the dialog goes away and comes back after 2 seconds, again and again, while the app stays blocked", async ({ page }) => {
  await login(page, { permission: "default" });
  for (let round = 0; round < 3; round++) {
    await dialog(page).getByRole("button", { name: "Not now" }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(gate(page)).toHaveAttribute("data-notification-gate", "blocked");
    await page.waitForTimeout(1200);
    await expect(dialog(page)).toHaveCount(0); // not back yet (< 2 s)
    await expect(dialog(page)).toBeVisible({ timeout: 2500 });
    await expect(gate(page)).toHaveAttribute("data-notification-gate", "blocked");
  }
  expect((await push(page)).prompts).toBe(0); // the native prompt is only ever opened by Enable Notifications
});

test("every protected page, opened directly, is blocked until notifications are set up", async ({ page }) => {
  await login(page, { permission: "default" });
  for (const path of PROTECTED) {
    await page.goto(path);
    await expect(dialog(page)).toBeVisible();
    await expect(gate(page)).toHaveAttribute("data-notification-gate", "blocked");
  }
  expect((await push(page)).prompts).toBe(0);
});

test("Enable Notifications: one native prompt, the device is registered on the server, and the app unblocks", async ({ page, request }) => {
  await login(page, { permission: "default", promptResult: "granted" });
  await dialog(page).getByRole("button", { name: "Enable Notifications" }).click();
  await expect(gate(page)).toHaveAttribute("data-notification-gate", "open");
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /Welcome back, Anni/ })).toBeVisible();
  expect(await push(page)).toEqual({ prompts: 1, subscribes: 1 });
  const rows = await dataRows(request, "PushSubscriptions");
  expect(rows).toHaveLength(1);
  expect(rows[0][1]).toBe("anni");
  await page.waitForTimeout(2500);
  await expect(dialog(page)).toHaveCount(0); // no stray reprompt after success
});

test("refresh and navigation: the state is re-derived, nothing is duplicated, and a lost server record is healed", async ({ page, request }) => {
  await login(page, { permission: "default", promptResult: "granted" });
  await dialog(page).getByRole("button", { name: "Enable Notifications" }).click();
  await expect(gate(page)).toHaveAttribute("data-notification-gate", "open");

  await page.reload();
  await expect(gate(page)).toHaveAttribute("data-notification-gate", "open");
  await page.goto("/all-jobs");
  await expect(gate(page)).toHaveAttribute("data-notification-gate", "open");
  expect(await dataRows(request, "PushSubscriptions")).toHaveLength(1); // same device, one row
  expect((await push(page)).subscribes).toBe(1);

  // The server forgets the device (expired/removed row): the browser still has its subscription, but the app is
  // only unblocked again once it has been registered again.
  await resetStore(request);
  await page.reload();
  await expect(gate(page)).toHaveAttribute("data-notification-gate", "open");
  // the re-check against the server runs on every load and re-registers the same device (still one row)
  await expect.poll(async () => (await dataRows(request, "PushSubscriptions")).length).toBe(1);
});

test("denied: blocked, Chrome site-settings instructions, the dialog reopens every 2 s, and Check Again works after the setting is changed", async ({ page, request }) => {
  await login(page, { permission: "denied" });
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByText(/Chrome has blocked notifications for JobSync/)).toBeVisible();
  await expect(dialog(page).getByText(/Site settings/).first()).toBeVisible();
  await expect(dialog(page).getByRole("button", { name: "Enable Notifications" })).toHaveCount(0);
  await expect(gate(page)).toHaveAttribute("data-notification-gate", "blocked");

  await dialog(page).getByRole("button", { name: "Close" }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(dialog(page)).toBeVisible({ timeout: 3500 });

  await dialog(page).getByRole("button", { name: "Check Again" }).click();
  await expect(dialog(page).getByRole("alert")).toContainText(/still blocking/);
  await expect(gate(page)).toHaveAttribute("data-notification-gate", "blocked");

  await setPush(page, "window.__push.setPermission('granted')"); // the member allowed it in Chrome's site settings
  await dialog(page).getByRole("button", { name: "Check Again" }).click();
  await expect(gate(page)).toHaveAttribute("data-notification-gate", "open");
  expect((await push(page)).prompts).toBe(0);
  expect(await dataRows(request, "PushSubscriptions")).toHaveLength(1);
});

test("granted but registration fails: stays blocked with an explanation; Retry registers once the problem is gone", async ({ page, request }) => {
  await login(page, { permission: "granted", subscribeFails: true });
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page)).toHaveAttribute("data-status", "error");
  await expect(gate(page)).toHaveAttribute("data-notification-gate", "blocked");
  expect(await dataRows(request, "PushSubscriptions")).toHaveLength(0);

  await setPush(page, "window.__push.setSubscribeFails(false)");
  await dialog(page).getByRole("button", { name: "Retry" }).click();
  await expect(gate(page)).toHaveAttribute("data-notification-gate", "open");
  expect(await dataRows(request, "PushSubscriptions")).toHaveLength(1);
  expect((await push(page)).prompts).toBe(0);
});

test("unsupported browser: an honest message and the app stays usable", async ({ page }) => {
  await login(page, { unsupported: true });
  await expect(dialog(page).getByText(/can’t receive JobSync push notifications/)).toBeVisible();
  await expect(dialog(page).getByRole("button", { name: "Enable Notifications" })).toHaveCount(0);
  await dialog(page).getByRole("button", { name: "Continue" }).click();
  await expect(gate(page)).toHaveAttribute("data-notification-gate", "open");
  await expect(page.getByRole("heading", { name: /Welcome back, Anni/ })).toBeVisible();
});

test("logout from the notification dialog works, stops the reprompt timer, and login re-checks everything", async ({ page }) => {
  await login(page, { permission: "default" });
  await dialog(page).getByRole("button", { name: "Not now" }).click(); // a reprompt timer is now pending
  await page.getByRole("button", { name: "Log out" }).click({ trial: true }).catch(() => undefined);
  await expect(dialog(page)).toBeVisible({ timeout: 3500 });
  await dialog(page).getByRole("button", { name: "Log out" }).click();
  await page.waitForURL("**/login");
  await page.waitForTimeout(2600);
  await expect(dialog(page)).toHaveCount(0); // nothing fires after logout
  // signing in again: the browser is still not set up, so the gate blocks again (state is re-derived)
  await page.getByRole("button", { name: "Lukky", exact: true }).click();
  await page.getByLabel("Access code for Lukky").fill("0002");
  await page.getByRole("button", { name: "Open Dashboard" }).click();
  await page.waitForURL("**/dashboard");
  await expect(dialog(page)).toBeVisible();
  await expect(gate(page)).toHaveAttribute("data-notification-gate", "blocked");
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
  expect((await request.post("/api/push/status", { data: {} })).status()).toBe(401);
  expect((await request.get("/api/cron/daily-notifications?slot=morning")).status()).toBe(401);
});

void installFakePush;
