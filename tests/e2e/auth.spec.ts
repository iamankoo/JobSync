import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const MEMBERS = [
  { id: "anni", name: "Anni", code: "0001", accent: "rgb(47, 107, 255)" },
  { id: "lukky", name: "Lukky", code: "0002", accent: "rgb(245, 197, 24)" },
  { id: "rishii", name: "Rishii", code: "0003", accent: "rgb(255, 77, 94)" },
];
const ROUTES = ["/dashboard", "/all-jobs", "/add-job", "/my-applications", "/analytics"];

// The notification onboarding dialog is a modal by design; these specs are not about it, so it is dismissed up front.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      for (const id of ["anni", "lukky", "rishii"]) sessionStorage.setItem(`jobsync:push-onboarding:${id}`, "1");
    } catch {
      /* ignore */
    }
  });
});

async function signIn(page: Page, name: string, code: string) {
  await page.goto("/login");
  await page.getByRole("button", { name }).click();
  await page.getByLabel(`Access code for ${name}`).fill(code);
  await page.getByRole("button", { name: "Open Dashboard" }).click();
  await page.waitForURL("**/dashboard");
}

test("login shows three profiles; selecting reveals the code panel; Back returns", async ({ page }) => {
  await page.goto("/login");
  for (const m of MEMBERS) await expect(page.getByRole("button", { name: m.name })).toBeVisible();
  await expect(page.getByLabel(/Access code for/)).toHaveCount(0);
  await page.getByRole("button", { name: "Lukky" }).click();
  await expect(page.getByLabel("Access code for Lukky")).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByLabel(/Access code for/)).toHaveCount(0);
});

test("eye toggle reveals and hides the code", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "Anni" }).click();
  const input = page.getByLabel("Access code for Anni");
  await expect(input).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "Show access code" }).click();
  await expect(input).toHaveAttribute("type", "text");
  await page.getByRole("button", { name: "Hide access code" }).click();
  await expect(input).toHaveAttribute("type", "password");
});

test("wrong code shows an error and stays on login", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "Rishii" }).click();
  await page.getByLabel("Access code for Rishii").fill("0001");
  await page.getByRole("button", { name: "Open Dashboard" }).click();
  await expect(page.locator("#code-error")).toContainText("Incorrect access code");
  await expect(page).toHaveURL(/\/login/);
});

for (const m of MEMBERS) {
  test(`${m.name}: session shows own name and accent theme; logout works`, async ({ page }) => {
    await signIn(page, m.name, m.code);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Welcome back, ${m.name}`);
    const shell = page.locator(`[data-member="${m.id}"]`);
    await expect(shell).toHaveCount(1);
    expect(await shell.evaluate((el) => getComputedStyle(el).getPropertyValue("--color-accent").trim())).not.toBe("");
    const cookies = await page.context().cookies();
    const session = cookies.find((c) => c.name === "jobsync_session");
    expect(session?.httpOnly).toBe(true);

    await page.getByRole("button", { name: "Log out" }).click();
    await page.waitForURL("**/login");
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
  });
}

test("a forged identity cookie is rejected", async ({ page, context }) => {
  await context.addCookies([{ name: "jobsync_session", value: "anni", url: "http://localhost:3100" }]);
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login/);
  await context.addCookies([{ name: "member", value: "anni", url: "http://localhost:3100" }]);
  await page.goto("/dashboard?member=anni");
  await expect(page).toHaveURL(/\/login/);
});

test("unauthenticated users are redirected from every protected route", async ({ page }) => {
  for (const r of ROUTES) {
    await page.goto(r);
    await expect(page).toHaveURL(/\/login/);
  }
});

test("navigation has exactly five working items", async ({ page, isMobile }) => {
  await signIn(page, "Anni", "0001");
  const expected = ["Dashboard", "All Jobs", "Add Job", "My Applications", "Analytics"];
  for (let i = 0; i < expected.length; i++) {
    if (isMobile) await page.getByRole("button", { name: "Open menu" }).click();
    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav.getByRole("link")).toHaveText(expected);
    await nav.getByRole("link", { name: expected[i], exact: true }).click();
    await page.waitForURL(`**${ROUTES[i]}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  }
});

test("login is rate limited after repeated failures", async ({ request }, testInfo) => {
  const headers = { "x-forwarded-for": testInfo.project.name === "mobile" ? "203.0.113.78" : "203.0.113.77" };
  for (let i = 0; i < 5; i++) {
    const r = await request.post("/api/auth/login", { data: { memberId: "lukky", code: "9999" }, headers });
    expect(r.status()).toBe(401);
  }
  const blocked = await request.post("/api/auth/login", { data: { memberId: "lukky", code: "0002" }, headers });
  expect(blocked.status()).toBe(429);
});

test("access codes are not present in client assets", async ({ page }) => {
  const bodies: string[] = [];
  page.on("response", async (res) => {
    if (res.url().includes("/_next/static/") && res.url().endsWith(".js")) bodies.push(await res.text().catch(() => ""));
  });
  await page.goto("/login");
  await page.waitForLoadState("networkidle");
  expect(bodies.length).toBeGreaterThan(0);
  for (const b of bodies) {
    expect(b).not.toContain("PROTOTYPE_CODES");
    expect(b).not.toContain("ACCESS_CODE_");
  }
});

test("accessibility: no axe violations on login and dashboard", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "Anni" }).click();
  const login = await new AxeBuilder({ page }).analyze();
  expect(login.violations).toEqual([]);
  await signIn(page, "Anni", "0001");
  const dash = await new AxeBuilder({ page }).analyze();
  expect(dash.violations).toEqual([]);
});

test("no horizontal scroll on login", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "Anni" }).click();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test.describe("data API (Phase 2)", () => {
  const configured = Boolean(process.env.GOOGLE_SHEETS_SPREADSHEET_ID);

  test("data routes reject unauthenticated requests", async ({ request }) => {
    for (const path of ["/api/jobs", "/api/applications", "/api/sheets/status"]) {
      const res = await request.get(path);
      expect(res.status(), path).toBe(401);
    }
    const put = await request.put("/api/applications/job_x", { data: { status: "Applied" } });
    expect(put.status()).toBe(401);
    const post = await request.post("/api/jobs", { data: {} });
    expect(post.status()).toBe(401);
  });

  test("signed in without Google configuration: safe 503, never fake data", async ({ request }, testInfo) => {
    test.skip(configured, "Google Sheets is configured in this environment");
    const ip = testInfo.project.name === "mobile" ? "203.0.113.91" : "203.0.113.90";
    const login = await request.post("/api/auth/login", { data: { memberId: "anni", code: "0001" }, headers: { "x-forwarded-for": ip } });
    expect(login.status()).toBe(200);
    const res = await request.get("/api/jobs");
    expect(res.status()).toBe(503);
    const body = await res.json();
    expect(body.data).toBeUndefined();
    expect(body.error.message).toContain("GOOGLE_SHEETS_SPREADSHEET_ID");
    expect(JSON.stringify(body)).not.toMatch(/BEGIN PRIVATE KEY/);
  });

  test("a client-supplied member ID cannot be used to act as someone else", async ({ request }, testInfo) => {
    const ip = testInfo.project.name === "mobile" ? "203.0.113.93" : "203.0.113.92";
    await request.post("/api/auth/login", { data: { memberId: "lukky", code: "0002" }, headers: { "x-forwarded-for": ip } });
    const res = await request.put("/api/applications/job_x", { data: { status: "Applied", memberId: "anni" } });
    // 400 when Sheets is configured (strict body rejects memberId); 503 when the membership check
    // cannot reach Sheets first. Either way the request is never accepted. Exact 400 is covered in
    // tests/integration/api-routes.test.ts.
    expect([400, 503]).toContain(res.status());
    expect((await res.json()).data).toBeUndefined();
  });
});
