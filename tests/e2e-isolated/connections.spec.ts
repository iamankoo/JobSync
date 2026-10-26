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

async function add(page: Page, fields: Partial<Record<"name" | "company" | "role" | "email" | "profile" | "message" | "notes", string>>) {
  const dialog = page.getByRole("dialog");
  if (fields.name !== undefined) await dialog.getByLabel(/Person's name/).fill(fields.name);
  if (fields.company !== undefined) await dialog.getByLabel(/^Company/).fill(fields.company);
  if (fields.role !== undefined) await dialog.getByLabel(/Role \/ designation/).fill(fields.role);
  if (fields.profile !== undefined) await dialog.getByLabel(/LinkedIn \/ profile URL/).fill(fields.profile);
  if (fields.message !== undefined) await dialog.getByLabel(/Message to send/).fill(fields.message);
  if (fields.notes !== undefined) await dialog.getByLabel(/^Notes/).fill(fields.notes);
  if (fields.email !== undefined) await dialog.getByLabel(/^Email/).fill(fields.email);
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
  // the Add form asks for an Email instead of a Status, and validates it
  await expect(page.getByRole("dialog").getByLabel(/^Status/)).toHaveCount(0);
  await add(page, { profile: "", email: "not-an-email" });
  await page.getByRole("dialog").getByRole("button", { name: "Add connection" }).click();
  await expect(page.getByRole("dialog").getByText("Enter a valid email address")).toBeVisible();
  expect(await dataRows(request, "Connections")).toHaveLength(0);

  await add(page, { profile: "https://www.linkedin.com/in/priya-test", company: "Acme Corp", role: "Engineering Manager", email: "priya@acme.example", message: MESSAGE, notes: "Met at a meetup" });
  await page.getByRole("dialog").getByRole("button", { name: "Add connection" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // The list shows only the headline facts...
  const row = page.getByTestId("connection-row").first();
  await expect(row.getByRole("button", { name: "Priya Sharma", exact: true })).toBeVisible();
  await expect(row.getByText("Acme Corp")).toBeVisible();
  await expect(row.getByText("Engineering Manager")).toBeVisible();
  // Email replaces the Status column in the list
  await expect(row.getByTestId("connection-row-email")).toHaveText("priya@acme.example");
  await expect(row.getByTestId("connection-row-email")).toHaveAttribute("href", "mailto:priya@acme.example");
  await expect(row.getByRole("combobox")).toHaveCount(0);
  await expect(page.getByRole("columnheader", { name: "Email" })).toBeAttached();
  await expect(page.getByRole("columnheader", { name: "Status" })).toHaveCount(0);
  await expect(row.getByTestId("connection-row-added-by")).toHaveText("You");
  await expect(row.locator("time")).toHaveAttribute("dateTime", /^\d{4}-\d{2}-\d{2}T/);
  await expect(row.getByText("Met at a meetup")).toHaveCount(0);
  await expect(row.getByTestId("connection-message")).toHaveCount(0);

  // ...and View opens every saved detail
  await row.getByRole("button", { name: "View Priya Sharma" }).click();
  const details = page.getByRole("dialog", { name: "Connection details" });
  await expect(details.getByTestId("connection-message")).toHaveText(MESSAGE.replace("\n", " ").replace(/\s+/g, " "));
  await expect(details.getByText("Met at a meetup")).toBeVisible();
  await expect(details.getByTestId("connection-added-by")).toContainText("Added by you");
  await expect(details.getByRole("combobox", { name: "Status of Priya Sharma" })).toHaveValue("Not Connected"); // new entries start Not Connected
  await expect(details.getByTestId("connection-email")).toHaveText("priya@acme.example");

  // the profile link is external and safe
  const link = details.getByRole("link", { name: /Open profile/ });
  await expect(link).toHaveAttribute("href", "https://www.linkedin.com/in/priya-test");
  await expect(link).toHaveAttribute("target", "_blank");
  expect(await link.getAttribute("rel")).toContain("noopener");

  // copy the suggested message
  await details.getByRole("button", { name: "Copy message" }).click();
  await expect(details.getByRole("button", { name: "Copied" })).toBeVisible();
  // Windows stores line breaks in the clipboard as CRLF.
  const copied = (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r/g, "");
  expect(copied).toBe(MESSAGE);
  // status can be changed from the details too, and the list follows
  await details.getByRole("combobox", { name: "Status of Priya Sharma" }).selectOption("Connected");
  await expect(page.getByRole("status").filter({ hasText: "marked as Connected" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // the page itself is only the title, the Add button and the list: no search box or status filters
  await expect(page.getByRole("searchbox", { name: /Search connections/ })).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Filter by status" })).toHaveCount(0);

  // every status can still be set (from the details) and persists across a reload
  for (const status of ["Messaged", "Reply", "Not Connected"]) {
    await page.getByRole("button", { name: "View Priya Sharma" }).click();
    await page.getByRole("dialog").getByRole("combobox", { name: "Status of Priya Sharma" }).selectOption(status);
    await expect(page.getByRole("status").filter({ hasText: `marked as ${status}` })).toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: "View Priya Sharma" }).click();
    await expect(page.getByRole("dialog").getByRole("combobox", { name: "Status of Priya Sharma" })).toHaveValue(status);
    await page.keyboard.press("Escape");
  }
  expect((await dataRows(request, "Connections"))[0].slice(1, 3)).toEqual(["anni", "Priya Sharma"]);
  expect((await dataRows(request, "Connections"))[0][9]).toBe("Not Connected");
  expect((await dataRows(request, "Connections"))[0][12]).toBe("priya@acme.example");

  // a second connection
  await page.getByRole("button", { name: "Add connection" }).first().click();
  await add(page, { name: "Rahul Verma", company: "Globex", message: "Hello Rahul" });
  await page.getByRole("dialog").getByRole("button", { name: "Add connection" }).click();
  await expect(page.getByTestId("connection-row")).toHaveCount(2);
  await expect(page.getByTestId("connection-row").first().getByRole("button", { name: "Rahul Verma", exact: true })).toBeVisible(); // newest first
  await page.getByRole("button", { name: "View Rahul Verma" }).click();
  await page.getByRole("dialog").getByRole("combobox", { name: "Status of Rahul Verma" }).selectOption("Reply");
  await expect(page.getByRole("status").filter({ hasText: "marked as Reply" })).toBeVisible();
  await page.keyboard.press("Escape");

  // edit from the details (clear the notes, change company)
  await page.getByRole("button", { name: "View Priya Sharma" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Edit Priya Sharma" }).click();
  await expect(page.getByRole("dialog", { name: "Edit connection" })).toBeVisible();
  await expect(page.getByRole("dialog").getByLabel(/^Email/)).toHaveValue("priya@acme.example");
  await expect(page.getByRole("dialog").getByLabel(/^Status/)).toHaveValue("Not Connected"); // status stays editable when editing
  await page.getByRole("dialog").getByLabel(/^Company/).fill("New Corp");
  await page.getByRole("dialog").getByLabel(/^Email/).fill("priya.sharma@newcorp.example");
  await page.getByRole("dialog").getByLabel(/^Notes/).fill("");
  await page.getByRole("dialog").getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByTestId("connection-row").filter({ hasText: "Priya Sharma" }).getByText("New Corp")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("connection-row").filter({ hasText: "Priya Sharma" }).getByText("New Corp")).toBeVisible();
  await expect(page.getByTestId("connection-row").filter({ hasText: "Priya Sharma" }).getByTestId("connection-row-email")).toHaveText("priya.sharma@newcorp.example");
  await page.getByRole("button", { name: "View Priya Sharma" }).click();
  await expect(page.getByRole("dialog").getByText("Met at a meetup")).toHaveCount(0);
  await page.keyboard.press("Escape");

  // edit from the row menu
  await page.getByRole("button", { name: "More actions: Rahul Verma" }).click();
  await page.getByRole("menuitem", { name: "Edit connection" }).click();
  await expect(page.getByRole("dialog", { name: "Edit connection" })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();

  // delete (confirmation first), from the row menu and from the details
  await page.getByRole("button", { name: "More actions: Rahul Verma" }).click();
  await page.getByRole("menuitem", { name: "Delete connection" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Keep" }).click();
  await expect(page.getByTestId("connection-row")).toHaveCount(2);
  await page.getByRole("button", { name: "View Rahul Verma" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete Rahul Verma" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove" }).click();
  await expect(page.getByTestId("connection-row")).toHaveCount(1);
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
  await expect(page.getByTestId("connection-row")).toHaveCount(1);
  await expect(page.getByTestId("connection-row-added-by")).toHaveText("You");
  const id = await page.evaluate(async () => (await (await fetch("/api/connections")).json()).data[0].connectionId as string);

  const other = await browser.newContext({ baseURL: info.project.use.baseURL, viewport: info.project.use.viewport ?? undefined, extraHTTPHeaders: info.project.use.extraHTTPHeaders });
  const lukky = await other.newPage();
  await signIn(lukky, "Lukky", "0002");
  await open(lukky);
  const row = lukky.getByTestId("connection-row");
  await expect(row).toHaveCount(1);
  await expect(row.getByRole("button", { name: "Shared contact", exact: true })).toBeVisible();
  await expect(row.getByTestId("connection-row-added-by")).toHaveText("Anni");
  // not the adder: status is read-only and there is no edit/delete menu
  await expect(row.getByRole("combobox")).toHaveCount(0);
  await expect(row.getByText("—").first()).toBeVisible(); // no email saved
  await expect(row.getByRole("button", { name: /More actions/ })).toHaveCount(0);
  await row.getByRole("button", { name: "View Shared contact" }).click();
  const details = lukky.getByRole("dialog", { name: "Connection details" });
  await expect(details.getByTestId("connection-message")).toHaveText("plan for everyone");
  await expect(details.getByTestId("connection-added-by")).toContainText("Added by Anni");
  await expect(details.getByRole("button", { name: /Edit|Delete/ })).toHaveCount(0);
  await expect(details.getByRole("combobox")).toHaveCount(0);
  await expect(details.getByText("Only Anni can edit or delete this entry.")).toBeVisible();
  await lukky.keyboard.press("Escape");
  // Lukky adds one too; Anni then sees both
  await lukky.getByRole("button", { name: "Add connection" }).first().click();
  await add(lukky, { name: "Lukky's find" });
  await lukky.getByRole("dialog").getByRole("button", { name: "Add connection" }).click();
  await expect(lukky.getByTestId("connection-row")).toHaveCount(2);
  await expect(lukky.getByTestId("connection-row").filter({ hasText: "Lukky's find" }).getByTestId("connection-row-added-by")).toHaveText("You");
  const attempts = await lukky.evaluate(async (cid) => {
    const put = await fetch(`/api/connections/${cid}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "Reply" }) });
    const del = await fetch(`/api/connections/${cid}`, { method: "DELETE" });
    return [put.status, del.status];
  }, id);
  expect(attempts).toEqual([403, 403]);
  await page.reload();
  await expect(page.getByTestId("connection-row")).toHaveCount(2);
  await other.close();
});
