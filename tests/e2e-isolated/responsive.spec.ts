import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  appendRows, appRow, daysAgoIso, dataRows, elementsOutsideViewport, goViaNav, horizontalOverflow, hoursAgoIso, jobRow, resetStore,
  seedRealisticData, signIn,
} from "./helpers";

/**
 * Runs once per viewport project (320x568, 375x812, 430x932, 768x1024, 1366x768, 1920x1080).
 * Every page and the critical interactions must stay coherent, readable, accessible and functional.
 */
const PAGES = [
  { label: "Dashboard", path: "/dashboard", h1: /Welcome back, Anni/ },
  { label: "All Jobs", path: "/all-jobs", h1: "All Jobs" },
  { label: "Add Job", path: "/add-job", h1: "Add New Job" },
  { label: "My Applications", path: "/my-applications", h1: "My Applications" },
  { label: "Analytics", path: "/analytics", h1: "Analytics" },
  { label: "Connections", path: "/connections", h1: "Connections" },
  { label: "Group Chat", path: "/group-chat", h1: "Group Chat" },
] as const;

async function press(locator: Locator, touch: boolean) {
  if (touch) await locator.tap();
  else await locator.click();
}

async function settle(page: Page) {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(700); // chart animations
}

async function shot(page: Page, project: string, name: string) {
  await page.screenshot({ path: `test-results/responsive/${project}__${name}.png`, fullPage: true });
}

test.beforeEach(async ({ request }) => {
  await seedRealisticData(request);
});

test("login page fits the viewport and works", async ({ page }, info) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "Anni", exact: true }).click();
  await expect(page.getByLabel("Access code for Anni")).toBeVisible();
  expect(await horizontalOverflow(page), "horizontal overflow").toBeLessThanOrEqual(0);
  expect(await elementsOutsideViewport(page)).toEqual([]);
  const panel = await page.getByLabel("Access code for Anni").boundingBox();
  const vp = page.viewportSize()!;
  expect(panel!.x).toBeGreaterThanOrEqual(0);
  expect(panel!.x + panel!.width).toBeLessThanOrEqual(vp.width);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await shot(page, info.project.name, "login");
});

test("every page: no overflow, readable layout, accessible, account pinned top-right, seven nav items", async ({ page }, info) => {
  const vp = page.viewportSize()!;
  await signIn(page, "Anni", "0001");
  for (const p of PAGES) {
    await goViaNav(page, p.label, p.path);
    await expect(page.getByRole("heading", { level: 1, name: p.h1 })).toBeVisible();
    await settle(page);

    expect(await horizontalOverflow(page), `${p.label}: horizontal page overflow`).toBeLessThanOrEqual(0);
    expect(await elementsOutsideViewport(page), `${p.label}: elements sticking out`).toEqual([]);

    // (On phones and tablets the Group Chat is full screen and hides the app header; every other page keeps it.)
    if (!(p.label === "Group Chat" && vp.width < 1024)) {
    // header: search usable; Log out sits just left of the account, which is the right-most item
    const header = page.locator("header");
    const search = header.getByRole("searchbox");
    await expect(search).toBeVisible();
    const logout = await header.getByRole("button", { name: "Log out" }).boundingBox();
    const avatar = await header.locator("img").last().boundingBox();
    expect(logout, "log out visible").not.toBeNull();
    expect(avatar, "account photo visible").not.toBeNull();
    expect(logout!.x + logout!.width).toBeLessThanOrEqual(avatar!.x + 1);
    expect(avatar!.x + avatar!.width).toBeLessThanOrEqual(vp.width);
    // on wide screens the member name sits to the right of the photo
    expect(vp.width - (avatar!.x + avatar!.width), "account stays at the far right").toBeLessThan(vp.width < 700 ? 40 : 120);
    const searchBox = (await search.boundingBox())!;
    expect(searchBox.width).toBeGreaterThan(150);
    expect(searchBox.x).toBeGreaterThanOrEqual(0);
    expect(searchBox.x + searchBox.width).toBeLessThanOrEqual(vp.width);

    // navigation: the five original items plus Connections and Group Chat (drawer or sidebar)
    const menu = page.getByRole("button", { name: "Open menu" });
    if (await menu.isVisible()) await menu.click();
    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav.getByRole("link")).toHaveText(["Dashboard", "All Jobs", "Add Job", "My Applications", "Analytics", "Connections", "Group Chat"]);
    if (await menu.isVisible()) await page.getByRole("button", { name: "Close menu" }).last().click();
    }

    expect((await new AxeBuilder({ page }).analyze()).violations, `${p.label}: accessibility`).toEqual([]);
    await shot(page, info.project.name, p.label.replace(/\s/g, "-").toLowerCase());
  }
});

test("All Jobs: table, filters, sorting, pagination and row actions work by touch or mouse", async ({ page }, info) => {
  const touch = Boolean(info.project.use.hasTouch);
  await signIn(page, "Anni", "0001");
  await goViaNav(page, "All Jobs", "/all-jobs");
  await settle(page);

  const vp = page.viewportSize()!;
  const cards = vp.width < 1280; // below xl the table becomes a list of cards
  if (cards) {
    // phones and tablets: each job is a card with labelled fields, no sideways scrolling needed
    await expect(page.locator("tbody tr").first()).toHaveCSS("display", "block");
    await expect(page.getByLabel("Sort by")).toBeVisible();
    const firstCard = (await page.locator("tbody tr").first().boundingBox())!;
    expect(firstCard.x + firstCard.width).toBeLessThanOrEqual(vp.width);
  } else {
    await expect(page.getByLabel("Sort by")).toBeHidden();
  }
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

  // filters are tappable (min touch size) and work
  const jobType = page.getByLabel("Job Type");
  expect((await jobType.boundingBox())!.height).toBeGreaterThanOrEqual(40);
  await jobType.selectOption("Internship");
  const rows = page.locator("tbody tr");
  expect(await rows.count()).toBeGreaterThan(0);
  await press(page.getByRole("button", { name: "Reset" }), touch);
  await expect(page.getByLabel("Job Type")).toHaveValue("");

  // sorting: header buttons on the table, the "Sort by" control on cards
  if (cards) await page.getByLabel("Sort by").selectOption("deadline:asc");
  else await press(page.getByRole("button", { name: /Deadline/ }), touch);
  await expect(page.getByRole("columnheader", { name: /Deadline/ })).toHaveAttribute("aria-sort", "ascending");

  // pagination (14 jobs -> 2 pages)
  await press(page.getByRole("button", { name: "Next page" }), touch);
  await expect(page.getByText(/Showing 11–14 of 14 jobs/)).toBeVisible();
  await press(page.getByRole("button", { name: "Previous page" }), touch);

  // status toggle and row menu are reachable
  const toggle = page.getByRole("button", { name: /: Not applied\. Mark as applied/ }).first();
  await toggle.scrollIntoViewIfNeeded();
  const t = (await toggle.boundingBox())!;
  expect(t.width).toBeGreaterThanOrEqual(36);
  expect(t.height).toBeGreaterThanOrEqual(36);
  await press(page.getByRole("button", { name: /More actions:/ }).first(), touch);
  await expect(page.getByRole("menu")).toBeVisible();
  const menuBox = (await page.getByRole("menu").boundingBox())!;
  expect(menuBox.x).toBeGreaterThanOrEqual(0);
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(vp.width);
  await page.keyboard.press("Escape");
});

test("dialogs fit the viewport and scroll inside themselves", async ({ page }, info) => {
  const touch = Boolean(info.project.use.hasTouch);
  const vp = page.viewportSize()!;
  await signIn(page, "Anni", "0001");
  await goViaNav(page, "All Jobs", "/all-jobs");
  await settle(page);

  const fits = async (dialog: Locator, label: string) => {
    const b = (await dialog.boundingBox())!;
    expect(b.x, `${label} left`).toBeGreaterThanOrEqual(-1);
    expect(b.y, `${label} top`).toBeGreaterThanOrEqual(-1);
    expect(b.x + b.width, `${label} right`).toBeLessThanOrEqual(vp.width + 1);
    expect(b.y + b.height, `${label} bottom`).toBeLessThanOrEqual(vp.height + 1);
  };

  // job details
  await press(page.getByRole("button", { name: /^E2E Test Role/ }).first(), touch);
  const details = page.getByRole("dialog", { name: "Job details" });
  await expect(details).toBeVisible();
  await fits(details, "details dialog");
  await shot(page, info.project.name, "dialog-details");
  await page.keyboard.press("Escape");

  // edit dialog (a job Anni added)
  await press(page.getByRole("button", { name: /More actions: E2E Test Role 4 /, exact: false }).first(), touch);
  await press(page.getByRole("menuitem", { name: "Edit job" }), touch);
  const edit = page.getByRole("dialog", { name: "Edit job" });
  await expect(edit).toBeVisible();
  await fits(edit, "edit dialog");
  const inputHeight = (await edit.getByLabel(/^Job Title/).boundingBox())!.height;
  expect(inputHeight).toBeGreaterThanOrEqual(44);
  await shot(page, info.project.name, "dialog-edit");
  await press(edit.getByRole("button", { name: "Cancel" }), touch);

  // delete confirmation
  await press(page.getByRole("button", { name: /More actions: E2E Test Role 4 /, exact: false }).first(), touch);
  await press(page.getByRole("menuitem", { name: "Delete job" }), touch);
  const del = page.getByRole("dialog", { name: "Delete this job?" });
  await fits(del, "delete dialog");
  await press(del.getByRole("button", { name: "Cancel" }), touch);

  // update-application dialog
  await goViaNav(page, "My Applications", "/my-applications");
  await settle(page);
  await press(page.getByRole("button", { name: /More actions:/ }).first(), touch);
  await press(page.getByRole("menuitem", { name: "Update status" }), touch);
  const update = page.getByRole("dialog", { name: "Update application" });
  await fits(update, "update dialog");
  await shot(page, info.project.name, "dialog-update");
});

test("Add Job form is comfortable on touch screens and validates", async ({ page }, info) => {
  const touch = Boolean(info.project.use.hasTouch);
  await signIn(page, "Anni", "0001");
  await goViaNav(page, "Add Job", "/add-job");
  await settle(page);
  for (const label of [/^Job Title/, /^Company/, /^Job Link/, /^Location/, /^Job Type/, /^Experience Level/]) {
    const box = (await page.getByLabel(label).boundingBox())!;
    expect(box.height, `${label}`).toBeGreaterThanOrEqual(44);
  }
  const submit = page.getByRole("button", { name: "Add Job" });
  await submit.scrollIntoViewIfNeeded();
  expect((await submit.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await press(submit, touch);
  await expect(page.getByText("Select a job type")).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});

test("Dashboard and Analytics: charts are visible, sized to the screen and not clipped", async ({ page }, info) => {
  const touch = Boolean(info.project.use.hasTouch);
  const vp = page.viewportSize()!;
  await signIn(page, "Anni", "0001");
  await settle(page);
  for (const [label, path] of [["Dashboard", "/dashboard"], ["Analytics", "/analytics"]] as const) {
    await goViaNav(page, label, path);
    await settle(page);
    for (const svg of await page.locator("main svg[role='img'], main figure svg").all()) {
      const b = await svg.boundingBox();
      if (!b) continue;
      expect(b.width, `${label} chart width`).toBeGreaterThan(20);
      expect(b.x + b.width, `${label} chart clipped on the right`).toBeLessThanOrEqual(vp.width + 1);
    }
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  }
  // timeline cells keep accessible labels at every size
  await expect(page.getByRole("img", { name: /^[A-Z][a-z]{2} \d{1,2}, \d{4}: \d+ actions?/ }).first()).toBeVisible();

  // tooltip: hover/focus on desktop, tap on touch; never clipped by the viewport
  const day = page.getByRole("img", { name: /^[A-Z][a-z]{2} \d{1,2}, \d{4}: \d+ actions?/ }).nth(touch ? 5 : 2);
  await day.scrollIntoViewIfNeeded();
  if (touch) await day.tap();
  else await day.hover();
  const tip = page.getByRole("tooltip");
  await expect(tip).toBeVisible();
  await expect(tip).toContainText(/Date: [A-Z][a-z]{2} \d{1,2}, \d{4}/);
  await expect(tip).toContainText(/Job Added: \d+/);
  await expect(tip).toContainText(/Job Applied: \d+/);
  await expect(tip).toContainText(/Streak: \d+ days?/);
  const tb = (await tip.boundingBox())!;
  expect(tb.x).toBeGreaterThanOrEqual(0);
  expect(tb.x + tb.width).toBeLessThanOrEqual(vp.width + 1);
  expect(tb.y).toBeGreaterThanOrEqual(0);
  if (!touch) {
    await page.mouse.move(2, 2);
    await expect(tip).toBeHidden();
    await day.focus();
    await expect(tip).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(tip).toBeHidden();
  }
});

test("follow-up modal: fits the viewport, can't be dismissed, has touch-sized choices, and saves the answer", async ({ page, request }, info) => {
  const touch = Boolean(info.project.use.hasTouch);
  const vp = page.viewportSize()!;
  await resetStore(request);
  await appendRows(request, "Jobs", [
    jobRow(1, { company: "A Synthetic Company With A Rather Long Name Incorporated", role: "Senior Staff Software Development Engineer In Test (Synthetic)", addedAt: hoursAgoIso(24 * 9) }),
    jobRow(2, { addedAt: hoursAgoIso(24 * 9) }),
  ]);
  await appendRows(request, "Applications", [
    appRow(1, "anni", "Applied", daysAgoIso(8)),
    appRow(2, "anni", "Applied", daysAgoIso(8.5)),
  ]);

  await signIn(page, "Anni", "0001");
  const modal = page.getByRole("alertdialog");
  await expect(modal).toBeVisible();
  await expect(page.getByText("Question 1 of 2")).toBeVisible();
  await expect(modal.getByRole("heading", { name: "What's the current status of this application?" })).toBeVisible();
  // oldest-due first: job 2 was applied 8.5 days ago
  await expect(modal).toContainText("E2E Test Role 2");

  const box = (await modal.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height + 1);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  for (const label of ["Yes, I've been shortlisted", "I've received an interview call", "I've received an offer", "No update yet"]) {
    const b = modal.getByRole("button", { name: label });
    await b.scrollIntoViewIfNeeded();
    expect((await b.boundingBox())!.height, label).toBeGreaterThanOrEqual(44);
  }
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await shot(page, info.project.name, "followup-modal");

  // cannot be bypassed: Escape, a click outside, and direct navigation all leave the question open
  await page.keyboard.press("Escape");
  await expect(modal).toBeVisible();
  await page.mouse.click(2, 2);
  await expect(modal).toBeVisible();
  await page.goto("/all-jobs");
  await expect(page.getByRole("alertdialog")).toBeVisible();

  // answer both questions in order; each is saved before the next appears
  await press(page.getByRole("alertdialog").getByRole("button", { name: "No update yet" }), touch);
  await expect(page.getByText("Question 2 of 2")).toBeVisible();
  await press(page.getByRole("alertdialog").getByRole("button", { name: "Yes, I've been shortlisted" }), touch);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);

  const apps = await dataRows(request, "Applications");
  const byJob = Object.fromEntries(apps.map((r) => [r[0], r]));
  expect(byJob["job_e2e2"][7]).toBe("No update");
  expect(byJob["job_e2e1"][7]).toBe("Shortlisted");
  expect(byJob["job_e2e1"][4]).toBe("Shortlisted");
  // reload: it does not come back
  await page.reload();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
});

test("Connections and Group Chat: usable layouts at this viewport (form, cards, composer, message list, controls)", async ({ page, request }, info) => {
  const vp = page.viewportSize()!;
  const touch = Boolean(info.project.use.hasTouch);
  await appendRows(request, "Connections", [
    ["conn_e2e1", "anni", "Priya Sharma With A Rather Long Name Indeed", "A Synthetic Company With A Rather Long Name Incorporated", "Senior Staff Software Development Engineer In Test", "https://www.linkedin.com/in/a-very-long-profile-name-that-keeps-going-and-going-and-going-12345", "", "Hi Priya, ".repeat(40), "Notes ".repeat(30), "Messaged", hoursAgoIso(5), hoursAgoIso(5)],
    ["conn_e2e2", "anni", "Rahul", "Globex", "", "", "", "Short", "", "Not Connected", hoursAgoIso(6), hoursAgoIso(6)],
  ]);
  await appendRows(request, "ChatMessages", Array.from({ length: 24 }, (_, i) => [
    `msg_e2e${i}`, ["lukky", "rishii", "anni"][i % 3], "text",
    i % 5 === 0 ? "A long message with an unbroken string " + "x".repeat(80) + " and a link https://example.com/" + "path/".repeat(12) : `Message ${i + 1} in the group chat`,
    "", "", "", "", "", hoursAgoIso(2 - i * 0.05),
  ]));
  await signIn(page, "Anni", "0001");

  // Connections: the list and its details stay inside the viewport and the form fits
  await goViaNav(page, "Connections", "/connections");
  await expect(page.getByTestId("connection-row")).toHaveCount(2);
  expect(await horizontalOverflow(page), "connections overflow").toBeLessThanOrEqual(0);
  expect(await elementsOutsideViewport(page), "connections: elements sticking out").toEqual([]);
  // every row has a touch-sized View button, and the details (long message, notes, links) fit the screen
  for (const name of ["View Priya Sharma With A Rather Long Name Indeed", "View Rahul"]) {
    const b = (await page.getByRole("button", { name }).boundingBox())!;
    expect(b.x + b.width, name).toBeLessThanOrEqual(vp.width);
    expect(b.height, `${name} height`).toBeGreaterThanOrEqual(36);
  }
  await press(page.getByRole("button", { name: "View Priya Sharma With A Rather Long Name Indeed" }), touch);
  const details = page.getByRole("dialog", { name: "Connection details" });
  await expect(details.getByTestId("connection-message")).toBeVisible();
  const dbox = (await details.boundingBox())!;
  expect(dbox.x).toBeGreaterThanOrEqual(0);
  expect(dbox.x + dbox.width).toBeLessThanOrEqual(vp.width);
  expect(await horizontalOverflow(page), "connection details overflow").toBeLessThanOrEqual(0);
  await shot(page, info.project.name, "connections-details");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Add connection" }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const box = (await dialog.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
  await dialog.getByLabel(/Person's name/).fill("Layout Test");
  expect((await new AxeBuilder({ page }).analyze()).violations, "connections form accessibility").toEqual([]);
  await shot(page, info.project.name, "connections-form");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await shot(page, info.project.name, "connections-list");

  // Group Chat
  // (The sidebar link's accessible name carries the unread count here, so match by prefix.)
  const menu = page.getByRole("button", { name: /Open menu/ });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /^Group Chat/ }).click();
  await page.waitForURL("**/group-chat");
  const log = page.getByRole("log", { name: "Chat messages" });
  await expect(log).toBeVisible();
  await expect(page.getByTestId("chat-message")).toHaveCount(24);
  await settle(page);
  expect(await horizontalOverflow(page), "chat overflow").toBeLessThanOrEqual(0);
  expect(await elementsOutsideViewport(page), "chat: elements sticking out").toEqual([]);

  // the newest message is in view and the composer + controls are fully on screen and touch-sized
  await expect(page.getByTestId("chat-message").last()).toBeInViewport();
  for (const name of ["Attach a file, image or PDF", "Record a voice note", "Start an audio call", "Start a video call"]) {
    const b = (await page.getByRole("button", { name }).boundingBox())!;
    expect(b, name).not.toBeNull();
    expect(b.x, name).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width, name).toBeLessThanOrEqual(vp.width);
    expect(b.y + b.height, name).toBeLessThanOrEqual(vp.height + 1);
    expect(b.height, `${name} height`).toBeGreaterThanOrEqual(40);
  }
  const composer = (await page.getByLabel("Message", { exact: true }).boundingBox())!;
  expect(composer.width).toBeGreaterThan(Math.min(160, vp.width * 0.4));
  expect(composer.y + composer.height).toBeLessThanOrEqual(vp.height + 1);
  // the page itself does not scroll: only the message list does
  expect(await page.evaluate(() => document.documentElement.scrollHeight - document.documentElement.clientHeight)).toBeLessThanOrEqual(24);

  // typing and sending works (with the on-screen keyboard's Enter adding a line on touch devices, the button sending)
  await page.getByLabel("Message", { exact: true }).fill("Layout check message");
  await press(page.getByRole("button", { name: "Send message" }), touch);
  await expect(page.getByTestId("chat-message").last()).toContainText("Layout check message");
  await expect(page.getByTestId("chat-message").last()).toBeInViewport();
  expect((await new AxeBuilder({ page }).analyze()).violations, "chat accessibility").toEqual([]);
  await shot(page, info.project.name, "group-chat");
});
