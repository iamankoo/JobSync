import { expect, test, type Page } from "@playwright/test";
import { dataRows, goViaNav, horizontalOverflow, resetStore, signIn } from "./helpers";

/** Connections page (shared list) in real Chromium (desktop and phone) against the isolated in-memory backend. */
test.beforeEach(async ({ request, context }) => {
  await resetStore(request);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => undefined);
});

const MESSAGE = "Hi Priya,\nI admire the work your team is doing at Acme Corp. I'd love to connect!";

async function open(page: Page) {
  await goViaNav(page, "Connections", "/connections");
  await expect(page.getByRole("heading", { level: 1, name: "Connections" })).toBeVisible();
}

async function add(page: Page, fields: Partial<Record<"name" | "company" | "role" | "profile" | "message" | "notes", string>>) {
  const dialog = page.getByRole("dialog");
  if (fields.name !== undefined) await dialog.getByLabel(/Person's name/).fill(fields.name);
  if (fields.company !== undefined) await dialog.getByLabel(/^Company/).fill(fields.company);
  if (fields.role !== undefined) await dialog.getByLabel(/Role \/ designation/).fill(fields.role);
  if (fields.profile !== undefined) await dialog.getByLabel(/LinkedIn \/ profile URL/).fill(fields.profile);
  if (fields.message !== undefined) await dialog.getByLabel(/Message to send/).fill(fields.message);
  if (fields.notes !== undefined) await dialog.getByLabel(/^Notes/).fill(fields.notes);
}

test("create, view message, change status, copy, open profile, edit, search/filter, persist, delete", async ({ page, request }) => {
  await signIn(page, "Anni", "0001");
  await open(page);

  // Navigation order: Connections sits right below Analytics, Group Chat below it.
  const menu = page.getByRole("button", { name: "Open menu" });
  if (await menu.isVisible()) await menu.click();
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link")).toHaveText(["Dashboard", "All Jobs", "Add Job", "My Applications", "Analytics", "Connections", "Group Chat"]);
  if (await menu.isVisible()) await page.getByRole("button", { name: "Close menu" }).last().click();

  await expect(page.getByText("No connections yet")).toBeVisible();
  await page.getByRole("button", { name: "Add your first connection" }).click();

  // validation first: nothing is saved with an empty name or a bad URL
  await page.getByRole("dialog").getByRole("button", { name: "Add connection" }).click();
  await expect(page.getByRole("dialog").getByText("Required")).toBeVisible();
  await add(page, { name: "Priya Sharma", profile: "not a url" });
  await page.getByRole("dialog").getByRole("button", { name: "Add connection" }).click();
  await expect(page.getByRole("dialog").getByText("Enter a valid http(s) URL")).toBeVisible();
  expect(await dataRows(request, "Connections")).toHaveLength(0);

  await add(page, { profile: "https://www.linkedin.com/in/priya-test", company: "Acme Corp", role: "Engineering Manager", message: MESSAGE, notes: "Met at a meetup" });
  await page.getByRole("dialog").getByRole("button", { name: "Add connection" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const card = page.getByTestId("connection-card").first();
  await expect(card.getByRole("heading", { name: "Priya Sharma" })).toBeVisible();
  await expect(card.getByText("Engineering Manager · Acme Corp")).toBeVisible();
  await expect(card.getByTestId("connection-message")).toHaveText(MESSAGE.replace("\n", " ").replace(/\s+/g, " "));
  await expect(card.getByRole("combobox", { name: "Status of Priya Sharma" })).toHaveValue("Not Connected");

  // the profile link is external and safe
  const link = card.getByRole("link", { name: /Open profile/ });
  await expect(link).toHaveAttribute("href", "https://www.linkedin.com/in/priya-test");
  await expect(link).toHaveAttribute("target", "_blank");
  expect(await link.getAttribute("rel")).toContain("noopener");

  // copy the suggested message
  await card.getByRole("button", { name: "Copy message" }).click();
  await expect(card.getByRole("button", { name: "Copied" })).toBeVisible();
  // Windows stores line breaks in the clipboard as CRLF.
  const copied = (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r/g, "");
  expect(copied).toBe(MESSAGE);

  // every status can be set and persists across a reload
  for (const status of ["Connected", "Messaged", "Reply", "Not Connected"]) {
    await card.getByRole("combobox", { name: "Status of Priya Sharma" }).selectOption(status);
    await expect(page.getByRole("status").filter({ hasText: `marked as ${status}` })).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("connection-card").first().getByRole("combobox", { name: "Status of Priya Sharma" })).toHaveValue(status);
  }
  expect((await dataRows(request, "Connections"))[0].slice(1, 3)).toEqual(["anni", "Priya Sharma"]);
  expect((await dataRows(request, "Connections"))[0][9]).toBe("Not Connected");

  // a second connection, then search and filter
  await page.getByRole("button", { name: "Add connection" }).first().click();
  await add(page, { name: "Rahul Verma", company: "Globex", message: "Hello Rahul" });
  await page.getByRole("dialog").getByRole("button", { name: "Add connection" }).click();
  await expect(page.getByTestId("connection-card")).toHaveCount(2);
  await page.getByRole("searchbox", { name: /Search connections/ }).fill("globex");
  await expect(page.getByTestId("connection-card")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "Rahul Verma" })).toBeVisible();
  await page.getByRole("searchbox", { name: /Search connections/ }).fill("zzz-nothing");
  await expect(page.getByText("No matching connections")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await page.getByTestId("connection-card").filter({ hasText: "Rahul Verma" }).getByRole("combobox").selectOption("Reply");
  await page.getByRole("button", { name: /^Reply \(1\)/ }).click();
  await expect(page.getByTestId("connection-card")).toHaveCount(1);
  await page.getByRole("button", { name: /^All \(2\)/ }).click();

  // edit (clear the notes, change company)
  await page.getByRole("button", { name: "Edit Priya Sharma" }).click();
  await page.getByRole("dialog").getByLabel(/^Company/).fill("New Corp");
  await page.getByRole("dialog").getByLabel(/^Notes/).fill("");
  await page.getByRole("dialog").getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Engineering Manager · New Corp")).toBeVisible();
  await page.reload();
  await expect(page.getByText("Engineering Manager · New Corp")).toBeVisible();
  await expect(page.getByText("Met at a meetup")).toHaveCount(0);

  // delete (confirmation first)
  await page.getByRole("button", { name: "Delete Rahul Verma" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Keep" }).click();
  await expect(page.getByTestId("connection-card")).toHaveCount(2);
  await page.getByRole("button", { name: "Delete Rahul Verma" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove" }).click();
  await expect(page.getByTestId("connection-card")).toHaveCount(1);
  expect(await dataRows(request, "Connections")).toHaveLength(1);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

  // the other tabs are untouched
  for (const tab of ["Jobs", "Applications", "Activity"] as const) expect(await dataRows(request, tab)).toHaveLength(tab === "Activity" ? (await dataRows(request, "Activity")).length : 0);
});

test("connections are SHARED: every member sees every entry; only the adder can edit or delete", async ({ page, browser }, info) => {
  await signIn(page, "Anni", "0001");
  await open(page);
  await page.getByRole("button", { name: "Add your first connection" }).click();
  await add(page, { name: "Shared contact", message: "plan for everyone" });
  await page.getByRole("dialog").getByRole("button", { name: "Add connection" }).click();
  await expect(page.getByTestId("connection-card")).toHaveCount(1);
  await expect(page.getByTestId("connection-added-by")).toContainText("Added by you");
  const id = await page.evaluate(async () => (await (await fetch("/api/connections")).json()).data[0].connectionId as string);

  const other = await browser.newContext({ baseURL: info.project.use.baseURL, viewport: info.project.use.viewport ?? undefined, extraHTTPHeaders: info.project.use.extraHTTPHeaders });
  const lukky = await other.newPage();
  await signIn(lukky, "Lukky", "0002");
  await open(lukky);
  const card = lukky.getByTestId("connection-card");
  await expect(card).toHaveCount(1);
  await expect(card.getByRole("heading", { name: "Shared contact" })).toBeVisible();
  await expect(card.getByTestId("connection-message")).toHaveText("plan for everyone");
  await expect(card.getByTestId("connection-added-by")).toContainText("Added by Anni");
  await expect(card.getByRole("button", { name: /Edit|Delete/ })).toHaveCount(0);
  await expect(card.getByRole("combobox")).toBeDisabled();
  // Lukky adds one too; Anni then sees both
  await lukky.getByRole("button", { name: "Add connection" }).first().click();
  await add(lukky, { name: "Lukky's find" });
  await lukky.getByRole("dialog").getByRole("button", { name: "Add connection" }).click();
  await expect(lukky.getByTestId("connection-card")).toHaveCount(2);
  await lukky.getByRole("searchbox", { name: /Search connections/ }).fill("anni");
  await expect(lukky.getByTestId("connection-card")).toHaveCount(1); // search also matches "added by"
  const attempts = await lukky.evaluate(async (cid) => {
    const put = await fetch(`/api/connections/${cid}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "Reply" }) });
    const del = await fetch(`/api/connections/${cid}`, { method: "DELETE" });
    return [put.status, del.status];
  }, id);
  expect(attempts).toEqual([403, 403]);
  await page.reload();
  await expect(page.getByTestId("connection-card")).toHaveCount(2);
  await other.close();
});
