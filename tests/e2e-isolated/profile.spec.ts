import { expect, test, type Page } from "@playwright/test";
import { E2E_RECOVERY_ANSWER } from "../../playwright.isolated.config";
import { appendRows, dataRows, horizontalOverflow, resetStore, signIn, updateRows } from "./helpers";

/**
 * Profile page (header profile button, details, resumes, professional photo, logout), the redesigned Gmail Drafts
 * page, the Dashboard Connections card and the Analytics Emails Sent card. Real Chromium, desktop and phone,
 * against the isolated in-memory backend.
 */
test.beforeEach(async ({ request }) => {
  await resetStore(request);
});

const pdf = (tag: string) => Buffer.from(`%PDF-1.4\n% ${tag}\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF`);
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

/** Reload and wait for the notification gate to open again (it re-renders the page once the device is verified). */
async function reload(page: Page) {
  await page.reload();
  await page.locator('[data-notification-gate="open"]').waitFor({ state: "attached" });
}

const PW = "e2e-profile-pass";

/** Passes the Profile Lock: sets the password the first time (both fields), otherwise enters it. */
async function unlockProfile(page: Page) {
  const setUp = page.getByRole("heading", { name: "Set Profile Password" });
  const enter = page.getByRole("heading", { name: "Profile Password" });
  await expect(setUp.or(enter)).toBeVisible();
  if (await setUp.isVisible()) {
    await page.getByLabel("Set Password").fill(PW);
    await page.getByLabel("Confirm Password").fill(PW);
    await page.getByRole("button", { name: "Save password" }).click();
  } else {
    await page.getByLabel("Password", { exact: true }).fill(PW);
    await page.getByRole("button", { name: "Unlock", exact: true }).click();
  }
  await expect(page.getByLabel("Name", { exact: true })).toBeVisible();
}

async function openProfile(page: Page) {
  await page.getByRole("link", { name: /Your profile/ }).click();
  await page.waitForURL("**/profile");
  await expect(page.getByRole("heading", { level: 1, name: "Profile" })).toBeVisible();
  await unlockProfile(page);
}

/** Every visit to Profile starts locked again. */
async function reloadUnlocked(page: Page) {
  await reload(page);
  await unlockProfile(page);
}

test("top-right profile button opens Profile; header has no Log out; details save, reload and edit", async ({ page }) => {
  await signIn(page, "Anni", "0001");
  const header = page.locator("header").first();
  await expect(header.getByRole("button", { name: /Log out/ })).toHaveCount(0);
  await expect(header.getByRole("link", { name: "Your profile (Anni)" })).toHaveCount(1);
  await openProfile(page);

  // Empty until the member types something (nothing invented).
  for (const label of ["Name", "LinkedIn ID or profile URL", "GitHub ID or profile URL", "Email", "Mobile number"]) await expect(page.getByLabel(label, { exact: true })).toHaveValue("");
  await expect(page.getByTestId("profile-updated")).toHaveText("Not saved yet");

  await page.getByLabel("Name", { exact: true }).fill("Anni Test");
  await page.getByLabel("LinkedIn ID or profile URL").fill("https://www.linkedin.com/in/anni-test");
  await page.getByLabel("GitHub ID or profile URL").fill("anni-test");
  await page.getByLabel("Email", { exact: true }).fill("not-an-email");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Enter a valid email address")).toBeVisible();
  await page.getByLabel("Email", { exact: true }).fill("anni.test@example.com");
  await page.getByLabel("Mobile number").fill("+91 98765 43210");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Profile saved." })).toBeVisible();
  await expect(page.getByTestId("profile-updated")).toContainText("Last updated");

  await reloadUnlocked(page);
  await expect(page.getByLabel("Email", { exact: true })).toHaveValue("anni.test@example.com");
  await expect(page.getByLabel("GitHub ID or profile URL")).toHaveValue("anni-test");
  await page.getByLabel("GitHub ID or profile URL").fill("");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Profile saved." })).toBeVisible();
  await reloadUnlocked(page);
  await expect(page.getByLabel("GitHub ID or profile URL")).toHaveValue("");
  await expect(page.getByLabel("Mobile number")).toHaveValue("+91 98765 43210");
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});

test("another member does not see my profile details", async ({ page, browser }) => {
  await signIn(page, "Anni", "0001");
  await openProfile(page);
  await page.getByLabel("Email", { exact: true }).fill("anni.private@example.com");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Profile saved." })).toBeVisible();

  const ctx = await browser.newContext({ baseURL: "http://localhost:3102", extraHTTPHeaders: { "x-test-key": "e2e-isolated-seed-key" } });
  const other = await ctx.newPage();
  await signIn(other, "Lukky", "0002");
  await openProfile(other);
  await expect(other.getByLabel("Email", { exact: true })).toHaveValue("");
  await expect(other.getByText("anni.private@example.com")).toHaveCount(0);
  await ctx.close();
});

test("resumes: upload (+), count, open/download, delete, own only", async ({ page, request }) => {
  await signIn(page, "Rishii", "0003");
  await openProfile(page);
  const card = page.getByRole("region", { name: "My Resumes" });
  await expect(card.getByTestId("resume-count")).toHaveText("0 / 10 resumes");

  await page.locator("#resume-input").setInputFiles({ name: "Rishii CV.pdf", mimeType: "application/pdf", buffer: pdf("one") });
  await expect(card.getByRole("list", { name: "Your resumes" }).getByText("Rishii CV.pdf", { exact: true })).toBeVisible();
  await page.locator("#resume-input").setInputFiles({ name: "Rishii CV 2.pdf", mimeType: "application/pdf", buffer: pdf("two") });
  await expect(card.getByTestId("resume-count")).toHaveText("2 / 10 resumes");

  // A wrong type is refused by the server.
  await page.locator("#resume-input").setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: PNG });
  await expect(card.getByRole("alert")).toContainText("Upload a PDF, DOC or DOCX file.");

  // Download returns the exact bytes for the owner.
  const href = await card.getByRole("link", { name: "Download Rishii CV.pdf" }).getAttribute("href");
  const res = await page.request.get(href!);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-disposition"]).toMatch(/^attachment;/);
  expect((await res.body()).equals(pdf("one"))).toBe(true);

  // Still there after a reload (persisted, not browser storage).
  await reloadUnlocked(page);
  await expect(card.getByTestId("resume-count")).toHaveText("2 / 10 resumes");

  // Another member cannot open it.
  const anni = await page.context().browser()!.newContext({ baseURL: "http://localhost:3102", extraHTTPHeaders: { "x-test-key": "e2e-isolated-seed-key" } });
  const anniPage = await anni.newPage();
  await signIn(anniPage, "Anni", "0001");
  expect((await anniPage.request.get(href!)).status()).toBe(403); // locked: nothing is served
  await anniPage.goto("/profile");
  await unlockProfile(anniPage);
  expect((await anniPage.request.get(href!)).status()).toBe(404); // even unlocked: not his file
  await expect(anniPage.getByRole("region", { name: "My Resumes" }).getByTestId("resume-count")).toHaveText("0 / 10 resumes");
  await anni.close();

  await card.getByRole("button", { name: "Delete Rishii CV.pdf" }).click();
  await card.getByRole("group", { name: "Confirm deleting Rishii CV.pdf" }).getByRole("button", { name: "Delete" }).click();
  await expect(card.getByText("Rishii CV.pdf", { exact: true })).toHaveCount(0);
  await expect(card.getByTestId("resume-count")).toHaveText("1 / 10 resumes");
  expect((await dataRows(request, "MemberFiles")).filter((r) => r[1] === "rishii")).toHaveLength(1);
});

test("resume limit: the + button is disabled at 10", async ({ page, request }) => {
  const rows = Array.from({ length: 10 }, (_, i) => [`res_e2e${i}`, "lukky", "resume", `file_e2e${i}`, `cv-${i}.pdf`, "application/pdf", "100", new Date(Date.now() - i * 60_000).toISOString()]);
  await appendRows(request, "MemberFiles", rows);
  await signIn(page, "Lukky", "0002");
  await openProfile(page);
  const card = page.getByRole("region", { name: "My Resumes" });
  await expect(card.getByTestId("resume-count")).toHaveText("10 / 10 resumes");
  await expect(card.getByRole("button", { name: "Resume limit reached (10)" })).toBeDisabled();
  await expect(card.getByText("Limit reached: delete a resume to upload another.")).toBeVisible();
});

test("professional photo: upload, replace, shown in the header avatar after reload", async ({ page }) => {
  await signIn(page, "Anni", "0001");
  await openProfile(page);
  const preview = page.getByTestId("profile-photo-preview");
  await expect(preview).toHaveAttribute("data-uploaded", "false");
  await page.locator("#profile-photo-input").setInputFiles({ name: "me.png", mimeType: "image/png", buffer: PNG });
  await expect(page.getByRole("status").filter({ hasText: "Photo uploaded." })).toBeVisible();
  await expect(preview).toHaveAttribute("data-uploaded", "true");
  const headerImg = page.getByRole("link", { name: "Your profile (Anni)" }).locator("img");
  await expect(headerImg).toHaveAttribute("src", /\/api\/members\/anni\/photo\?v=/);
  const first = await headerImg.getAttribute("src");

  await expect(page.getByRole("button", { name: "Replace photo" })).toBeVisible();
  await page.locator("#profile-photo-input").setInputFiles({ name: "me2.png", mimeType: "image/png", buffer: PNG });
  await expect(page.getByRole("status").filter({ hasText: "Photo replaced." })).toBeVisible();
  await expect(headerImg).not.toHaveAttribute("src", first!);

  await reload(page);
  await expect(page.getByRole("link", { name: "Your profile (Anni)" }).locator("img")).toHaveAttribute("src", /\/api\/members\/anni\/photo\?v=/);
  // The image route actually serves it.
  const src = await page.getByRole("link", { name: "Your profile (Anni)" }).locator("img").getAttribute("src");
  expect((await page.request.get(src!)).headers()["content-type"]).toBe("image/png");
});

test("Log out from the bottom of the Profile page", async ({ page }) => {
  await signIn(page, "Lukky", "0002");
  await openProfile(page);
  await page.getByRole("button", { name: "Log out" }).click();
  await page.waitForURL("**/login");
  await page.goto("/profile");
  await expect(page).toHaveURL(/\/login/);
});

test("Gmail Drafts: all three connected in the header; Disconnect only affects me, after confirming", async ({ page, request }) => {
  const at = new Date().toISOString();
  await appendRows(request, "NF_GmailAccounts", ["anni", "lukky", "rishii"].map((m) => [m, `${m}.e2e@gmail.example`, "not-a-real-token", "openid email https://www.googleapis.com/auth/gmail.compose", "connected", at, at, ""]));
  await signIn(page, "Anni", "0001");
  await page.goto("/gmail");
  await expect(page.getByRole("heading", { level: 1, name: "Gmail drafts" })).toBeVisible();
  const team = page.getByTestId("gmail-connected-members");
  await expect(team).toContainText("Connected:");
  for (const name of ["Anni", "Lukky", "Rishii"]) await expect(team.getByRole("img", { name: `${name}: Gmail connected` })).toBeVisible();
  await expect(page.getByText("Team", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("gmail-my-status")).toHaveText("Connected: anni.e2e@gmail.example");
  await expect(page.getByText("lukky.e2e@gmail.example")).toHaveCount(0);
  await expect(page.getByText(/never sends anything/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Reconnect Gmail" })).toBeVisible();

  await page.getByRole("button", { name: "Disconnect Gmail" }).click();
  await page.getByRole("group", { name: "Confirm disconnect" }).getByRole("button", { name: "Cancel" }).click();
  expect((await dataRows(request, "NF_GmailAccounts")).every((r) => r[4] === "connected")).toBe(true);

  await page.getByRole("button", { name: "Disconnect Gmail" }).click();
  await page.getByRole("button", { name: "Yes, disconnect my Gmail" }).click();
  await expect(page.getByTestId("gmail-my-status")).toHaveText("Not connected");
  await expect(team.getByRole("img", { name: "Anni: Gmail not connected" })).toBeVisible();
  const rows = await dataRows(request, "NF_GmailAccounts");
  expect(rows.find((r) => r[0] === "anni")![4]).toBe("disconnected");
  expect(rows.filter((r) => r[0] !== "anni").every((r) => r[4] === "connected")).toBe(true);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});

test("Dashboard Connections card opens the Connections page", async ({ page, request }) => {
  const at = new Date().toISOString();
  await appendRows(request, "Connections", [["conn_e2e1", "anni", "Priya", "Acme", "", "", "", "", "", "Messaged", at, at, ""]]);
  await signIn(page, "Lukky", "0002");
  const card = page.getByRole("link", { name: /^Connections: 1 people/ });
  await expect(card).toBeVisible();
  await expect(card).toContainText("1 Messaged");
  await card.click();
  await page.waitForURL("**/connections");
  await expect(page.getByRole("heading", { level: 1, name: "Connections" })).toBeVisible();
});

test("Analytics Emails Sent counts only sent drafts, with a per-member breakdown", async ({ page, request }) => {
  const at = new Date().toISOString();
  const d = (k: string, m: string, s: string) => [k, m, "contact", k, `d-${k}`, s, at, "", `t-${k}`, at];
  await appendRows(request, "NF_Drafts", [d("k1", "anni", "sent"), d("k2", "anni", "created"), d("k3", "lukky", "sent"), d("k4", "lukky", "sent"), d("k5", "rishii", "deleted")]);
  await signIn(page, "Anni", "0001");
  await page.goto("/analytics");
  const card = page.getByTestId("emails-sent-card");
  await expect(card.getByRole("heading", { name: "Emails Sent" })).toBeVisible();
  await expect(card.getByTestId("emails-sent-total")).toHaveText("3");
  await expect(card.getByTestId("emails-sent-anni")).toHaveText("1");
  await expect(card.getByTestId("emails-sent-lukky")).toHaveText("2");
  await expect(card.getByTestId("emails-sent-rishii")).toHaveText("0");
});

// ---------- Profile Lock ----------

test("Profile Lock: first-time setup needs matching entries; wrong password stays locked; Reset Password message", async ({ page, request }) => {
  await signIn(page, "Lukky", "0002");
  await page.getByRole("link", { name: /Your profile/ }).click();
  await page.waitForURL("**/profile");
  await expect(page.getByRole("heading", { name: "Set Profile Password" })).toBeVisible();
  await expect(page.getByLabel("Name", { exact: true })).toHaveCount(0);

  // Mismatch: nothing saved, still locked, confirmation must be entered again.
  await page.getByLabel("Set Password").fill(PW);
  await page.getByLabel("Confirm Password").fill(`${PW}x`);
  await page.getByRole("button", { name: "Save password" }).click();
  await expect(page.locator("form").getByRole("alert")).toHaveText("Passwords do not match. Please try again.");
  await expect(page.getByLabel("Confirm Password")).toHaveValue("");
  await expect(page.getByLabel("Name", { exact: true })).toHaveCount(0);
  expect((await dataRows(request, "Members")).find((r) => r[0] === "lukky")![10] ?? "").toBe("");

  await page.getByLabel("Confirm Password").fill(PW);
  await page.getByRole("button", { name: "Save password" }).click();
  await expect(page.getByLabel("Name", { exact: true })).toBeVisible();
  expect((await dataRows(request, "Members")).find((r) => r[0] === "lukky")![10]).toMatch(/^scrypt1\$/);

  // Next visit: password screen; a wrong password shows only the error.
  await reload(page);
  await expect(page.getByRole("heading", { name: "Profile Password" })).toBeVisible();
  await page.getByLabel("Password", { exact: true }).fill("wrong-password");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(page.locator("form").getByRole("alert")).toHaveText("Incorrect password.");
  await expect(page.getByLabel("Name", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Reset Password" }).click();
  await expect(page.getByText("Please contact the Admin to reset your password.")).toBeVisible();
  // Not the admin: no recovery option.
  await expect(page.getByRole("button", { name: "Another way to unlock" })).toHaveCount(0);
  await page.getByLabel("Password", { exact: true }).fill(PW);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(page.getByLabel("Name", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reset Passwords" })).toHaveCount(0);
});

test("Admin: Anni resets Lukky's password; Lukky must set a new one", async ({ page, browser }) => {
  const lukkyCtx = await browser.newContext({ baseURL: "http://localhost:3102", extraHTTPHeaders: { "x-test-key": "e2e-isolated-seed-key" } });
  const lukky = await lukkyCtx.newPage();
  await signIn(lukky, "Lukky", "0002");
  await openProfile(lukky); // sets Lukky's password

  await signIn(page, "Anni", "0001");
  await openProfile(page);
  await page.getByRole("button", { name: "Reset Passwords" }).click();
  const list = page.getByRole("list", { name: "Members" });
  for (const name of ["Anni", "Lukky", "Rishii"]) await expect(list.getByText(name, { exact: true })).toBeVisible();
  await list.getByRole("button", { name: "Reset Lukky's password" }).click();
  await page.getByRole("group", { name: "Confirm reset for Lukky" }).getByRole("button", { name: "Confirm reset" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Lukky's Profile Password was reset." })).toBeVisible();

  // Lukky's open Profile no longer works, and the next visit asks for a new password.
  await reload(lukky);
  await expect(lukky.getByRole("heading", { name: "Set Profile Password" })).toBeVisible();
  await lukkyCtx.close();
});

test("Anni: \"Another way to unlock\" with the right answer; a wrong answer stays locked", async ({ page }) => {
  await signIn(page, "Anni", "0001");
  await openProfile(page); // sets Anni's password
  await reload(page);
  await page.getByRole("button", { name: "Another way to unlock" }).click();
  await expect(page.getByLabel("What is the name of your favourite game?")).toBeVisible();
  expect((await page.content()).toLowerCase()).not.toContain(E2E_RECOVERY_ANSWER.toLowerCase()); // never shown
  await page.getByLabel("What is the name of your favourite game?").fill("Tetris");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(page.locator("form").getByRole("alert")).toHaveText("That answer is not correct.");
  await expect(page.getByLabel("Name", { exact: true })).toHaveCount(0);
  await page.getByLabel("What is the name of your favourite game?").fill(E2E_RECOVERY_ANSWER);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(page.getByLabel("Name", { exact: true })).toBeVisible();
});

test("Locked Profile: the page and the profile APIs contain no profile, resume or Gmail data", async ({ page, request }) => {
  const at = new Date().toISOString();
  await updateRows(request, "Members", { MemberID: "rishii" }, { ProfileName: "Rishii Hidden", Email: "rishii.hidden@example.com", Mobile: "+91 90000 00000" });
  await appendRows(request, "MemberFiles", [["res_e2elock", "rishii", "resume", "file_e2elock", "rishii-hidden-cv.pdf", "application/pdf", "100", at]]);
  await appendRows(request, "NF_GmailAccounts", [["rishii", "rishii.hidden@gmail.example", "not-a-real-token", "openid email https://www.googleapis.com/auth/gmail.compose", "connected", at, at, ""]]);
  await signIn(page, "Rishii", "0003");
  await page.goto("/profile");
  await expect(page.getByRole("heading", { name: "Set Profile Password" })).toBeVisible();
  const html = await page.content();
  for (const s of ["Rishii Hidden", "rishii.hidden@example.com", "90000", "rishii-hidden-cv.pdf", "rishii.hidden@gmail.example"]) expect(html).not.toContain(s);
  for (const url of ["/api/profile", "/api/profile/resumes", "/api/profile/resumes/res_e2elock"]) {
    const res = await page.request.get(url);
    expect(res.status(), url).toBe(403);
    expect(await res.text()).not.toContain("rishii.hidden");
  }
  // After unlocking, the data appears.
  await unlockProfile(page);
  await expect(page.getByLabel("Email", { exact: true })).toHaveValue("rishii.hidden@example.com");
  await expect(page.getByTestId("profile-gmail-status")).toHaveText("Connected: rishii.hidden@gmail.example");
  await expect(page.getByRole("list", { name: "Your resumes" }).getByText("rishii-hidden-cv.pdf")).toBeVisible();
});
