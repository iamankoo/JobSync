import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// The e2e server runs with Google Sheets deliberately UNCONFIGURED (see playwright.config.ts), so it
// can never read or write the real spreadsheet. These tests cover what the browser shows then:
// real error states (never sample data), navigation, search, theme and accessibility.
// Data behaviour (lists, filters, status changes, add job) is covered by the unit/integration tests.

const MEMBERS = [
  { id: "anni", name: "Anni", code: "0001", accent: "rgb(37, 99, 235)", onAccent: "rgb(255, 255, 255)" },
  { id: "lukky", name: "Lukky", code: "0002", accent: "rgb(245, 197, 24)", onAccent: "rgb(26, 20, 0)" },
  { id: "rishii", name: "Rishii", code: "0003", accent: "rgb(225, 29, 72)", onAccent: "rgb(255, 255, 255)" },
];

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

const PAGES = [
  { path: "/all-jobs", heading: "All Jobs" },
  { path: "/add-job", heading: "Add New Job" },
  { path: "/my-applications", heading: "My Applications" },
];

test.describe("Phase 3 pages without a data connection", () => {
  for (const p of PAGES) {
    test(`${p.heading}: shows a safe error state, never sample data`, async ({ page }) => {
      await signIn(page, "Anni", "0001");
      await page.goto(p.path);
      await expect(page.getByRole("heading", { level: 1, name: p.heading })).toBeVisible();
      const alert = page.getByRole("alert").filter({ hasText: "Can't reach the job database" });
      await expect(alert).toBeVisible();
      await expect(alert).toContainText("GOOGLE_SHEETS_SPREADSHEET_ID");
      await expect(page.getByRole("table")).toHaveCount(0);
      await expect(page.getByText(/Synthetic|Microsoft|Amazon|Netflix|Flipkart|Swiggy|Zepto/)).toHaveCount(0);
    });
  }

  test("protected data pages redirect to login without a session", async ({ page }) => {
    for (const p of PAGES) {
      await page.goto(p.path);
      await expect(page).toHaveURL(/\/login/);
    }
  });

  test("the global search box submits to All Jobs and Ctrl+K focuses it", async ({ page, isMobile }) => {
    await signIn(page, "Anni", "0001");
    const search = page.getByRole("searchbox", { name: /Search jobs by title/ });
    await expect(search).toBeVisible();
    if (!isMobile) {
      await page.keyboard.press("Control+k");
      await expect(search).toBeFocused();
    }
    await search.fill("data analyst");
    await search.press("Enter");
    await page.waitForURL("**/all-jobs?q=data%20analyst");
    await expect(page.getByRole("heading", { level: 1, name: "All Jobs" })).toBeVisible();
  });

  test("the sidebar still has exactly the five items and My Applications/Add Job/All Jobs navigate", async ({ page, isMobile }) => {
    await signIn(page, "Anni", "0001");
    const go = async (label: string, path: string) => {
      if (isMobile) await page.getByRole("button", { name: "Open menu" }).click();
      await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: label, exact: true }).click();
      await page.waitForURL(`**${path}`);
    };
    await go("All Jobs", "/all-jobs");
    await go("Add Job", "/add-job");
    await go("My Applications", "/my-applications");
  });

  for (const m of MEMBERS) {
    test(`${m.name}: accent theme drives the active nav item and the page is accessible`, async ({ page, isMobile }) => {
      await signIn(page, m.name, m.code);
      await page.goto("/all-jobs");
      if (isMobile) await page.getByRole("button", { name: "Open menu" }).click();
      const active = page.getByRole("navigation", { name: "Main" }).locator('a[aria-current="page"]');
      await expect(active).toHaveText("All Jobs");
      await expect(active).toHaveCSS("background-color", m.accent);
      await expect(active).toHaveCSS("color", m.onAccent);
      if (isMobile) await page.getByRole("button", { name: "Close menu" }).last().click();

      const results = await new AxeBuilder({ page }).analyze();
      expect(results.violations).toEqual([]);
    });
  }
});
