import { expect, test, type Locator, type Page } from "@playwright/test";
import { appendRows, dataRows, goViaNav, horizontalOverflow, resetStore, signIn } from "./helpers";

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

type Fields = Partial<Record<"name" | "company" | "designation" | "email" | "url" | "category" | "role", string>>;
/** Fills the six-field form (Role to Apply = category + specific role, or a custom role for "Other"). */
async function add(page: Page, fields: Fields) {
  const dialog = page.getByRole("dialog");
  if (fields.name !== undefined) await dialog.getByLabel(/^Person Name/).fill(fields.name);
  if (fields.company !== undefined) await dialog.getByLabel(/^Company Name/).fill(fields.company);
  if (fields.designation !== undefined) await dialog.getByLabel(/^Person Designation/).fill(fields.designation);
  if (fields.email !== undefined) await dialog.getByLabel(/^Person Email/).fill(fields.email);
  if (fields.url !== undefined) await dialog.getByLabel(/^Company URL/).fill(fields.url);
  if (fields.category !== undefined) await pickRole(dialog, fields.category, fields.category === "Other" ? undefined : fields.role);
  if (fields.category === "Other" && fields.role !== undefined) await dialog.getByLabel("Custom role").fill(fields.role);
}
const roleField = (dialog: Locator) => dialog.getByRole("button", { name: /Role to Apply/ });
/** The single two-step dropdown: open it, choose a category, then (unless Other) a role. */
async function pickRole(dialog: Locator, category: string, role?: string) {
  await roleField(dialog).click();
  await dialog.getByRole("menuitem", { name: category, exact: true }).click();
  if (role) await dialog.getByRole("menuitem", { name: role, exact: true }).click();
}
/** The open menu sits entirely above its field and inside the modal's visible area. */
async function expectMenuAboveAndVisible(page: Page, dialog: Locator) {
  const menu = dialog.getByRole("menu");
  await expect(menu).toBeVisible();
  const m = (await menu.boundingBox())!;
  const t = (await roleField(dialog).boundingBox())!;
  const body = (await dialog.locator(".overflow-y-auto").first().boundingBox())!;
  expect(m.y + m.height).toBeLessThanOrEqual(t.y + 0.5); // above the field
  expect(m.y).toBeGreaterThanOrEqual(body.y - 0.5); // not clipped by the modal body
  expect(m.y).toBeGreaterThanOrEqual(0);
  expect(m.x).toBeGreaterThanOrEqual(0);
  expect(m.x + m.width).toBeLessThanOrEqual(page.viewportSize()!.width + 0.5);
}
/** The smallest valid connection. */
const valid = (name: string, over: Fields = {}): Fields => ({ name, company: "Acme Corp", email: `${name.toLowerCase().replace(/\W/g, "")}@acme.example`, category: "SDE", role: "Software Engineer", ...over });

test("create, view details, change status, edit, persist, delete (six-field form)", async ({ page, request }) => {
  await signIn(page, "Anni", "0001");
  await open(page);

  // Navigation order: Connections sits right below Analytics, Group Chat below it.
  const menu = page.getByRole("button", { name: "Open menu" });
  if (await menu.isVisible()) await menu.click();
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link")).toHaveText(["Dashboard", "All Jobs", "Add Job", "My Applications", "Analytics", "Connections", "Group Chat", "Gmail Drafts"]);
  if (await menu.isVisible()) await page.getByRole("button", { name: "Close menu" }).last().click();

  await expect(page.getByText("No connections yet")).toBeVisible();
  await page.getByRole("button", { name: "Add your first connection" }).click();
  const dialog = page.getByRole("dialog");

  // exactly the six fields; the removed ones are gone
  await expect(dialog.locator('label, [id$="-role-label"]')).toHaveText([/^Person Name/, /^Person Designation/, /^Person Email/, /^Company Name/, /^Company URL/, /^Role to Apply/]);
  for (const gone of [/LinkedIn/, /Other profile/, /Message to send/, /^Notes/, /^Status/]) await expect(dialog.getByLabel(gone)).toHaveCount(0);

  // validation first: nothing is saved while a required value is missing or invalid
  await dialog.getByRole("button", { name: "Add connection" }).click();
  await expect(dialog.getByText("Required")).toHaveCount(3);
  await expect(dialog.getByText("Choose a role category")).toBeVisible();
  await add(page, { name: "Priya Sharma", company: "Acme Corp", email: "not-an-email", url: "javascript:alert(1)", category: "SDE" });
  await dialog.getByRole("button", { name: "Add connection" }).click();
  await expect(dialog.getByText("Enter a valid email address")).toBeVisible();
  await expect(dialog.getByText(/valid website address/)).toBeVisible();
  await expect(dialog.getByText("Choose a role category")).toBeVisible(); // a category with no role chosen is not saved
  expect(await dataRows(request, "Connections")).toHaveLength(0);

  // ONE dropdown, two steps, always opening upward: categories, then that category's roles with Back on top
  await roleField(dialog).click();
  await expectMenuAboveAndVisible(page, dialog);
  await expect(dialog.getByRole("menuitem")).toHaveText(["SDE", "AI/ML", "Web D", "Data", "Other"]);
  await dialog.getByRole("menuitem", { name: "SDE", exact: true }).click();
  await expectMenuAboveAndVisible(page, dialog);
  await expect(dialog.getByRole("menuitem")).toHaveText(["Back", "Software Engineer", "Software Developer", "Backend Engineer"]);
  await dialog.getByRole("menuitem", { name: "Back", exact: true }).click(); // still open, back on the categories
  await expect(dialog.getByRole("menuitem")).toHaveText(["SDE", "AI/ML", "Web D", "Data", "Other"]);
  await dialog.getByRole("menuitem", { name: "AI/ML", exact: true }).click();
  await expectMenuAboveAndVisible(page, dialog);
  await expect(dialog.getByRole("menuitem")).toHaveCount(7);
  await page.keyboard.press("Escape"); // closes the menu (not the modal)
  await expect(dialog.getByRole("menu")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toBeVisible();
  await roleField(dialog).click();
  await dialog.getByLabel(/^Person Name/).click(); // outside click closes it
  await expect(dialog.getByRole("menu")).toHaveCount(0);
  await pickRole(dialog, "SDE", "Backend Engineer");
  await expect(roleField(dialog)).toContainText("Backend Engineer");
  await pickRole(dialog, "Other");
  await expect(roleField(dialog)).not.toContainText("Backend Engineer"); // a new category cleared the old role
  await expect(dialog.getByLabel("Custom role")).toBeVisible();
  await dialog.getByRole("button", { name: "Add connection" }).click();
  await expect(dialog.getByText("Enter the role")).toBeVisible();

  await add(page, { email: "priya@acme.example", url: "acme.com", designation: "Engineering Manager", category: "AI/ML", role: "Machine Learning Engineer" });
  await dialog.getByRole("button", { name: "Add connection" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // the six values (and nothing historical) are in the sheet
  const saved = (await dataRows(request, "Connections"))[0];
  expect(saved.slice(2, 5)).toEqual(["Priya Sharma", "Acme Corp", "Engineering Manager"]);
  expect(saved.slice(5, 9)).toEqual(["", "", "", ""]);
  expect(saved.slice(12, 16)).toEqual(["priya@acme.example", "https://acme.com/", "AI/ML", "Machine Learning Engineer"]);

  // The list shows only the headline facts...
  const row = page.getByTestId("connection-row").first();
  await expect(row.getByRole("button", { name: "Priya Sharma", exact: true })).toBeVisible();
  await expect(row.getByText("Acme Corp")).toBeVisible();
  await expect(row.getByText("Engineering Manager")).toBeVisible();
  await expect(row.getByTestId("connection-row-email")).toHaveText("priya@acme.example");
  await expect(row.getByTestId("connection-row-email")).toHaveAttribute("href", "mailto:priya@acme.example");
  await expect(row.getByRole("combobox")).toHaveCount(0);
  await expect(page.getByRole("columnheader", { name: "Designation" })).toBeAttached();
  await expect(row.getByTestId("connection-row-added-by")).toHaveText("You");
  await expect(row.locator("time")).toHaveAttribute("dateTime", /^\d{4}-\d{2}-\d{2}T/);

  // ...and View opens every saved detail (no empty "message / notes / links" sections for a new connection)
  await row.getByRole("button", { name: "View Priya Sharma" }).click();
  const details = page.getByRole("dialog", { name: "Connection details" });
  await expect(details.getByTestId("connection-apply-role")).toContainText("Machine Learning Engineer");
  await expect(details.getByTestId("connection-apply-role")).toContainText("AI/ML");
  const site = details.getByTestId("connection-company-url");
  await expect(site).toHaveAttribute("href", "https://acme.com/");
  await expect(site).toHaveAttribute("target", "_blank");
  expect(await site.getAttribute("rel")).toContain("noopener");
  await expect(details.getByTestId("connection-message")).toHaveCount(0);
  await expect(details.getByText("Earlier notes")).toHaveCount(0);
  await expect(details.getByTestId("connection-added-by")).toContainText("Added by you");
  await expect(details.getByRole("combobox", { name: "Status of Priya Sharma" })).toHaveValue("Not Connected"); // new entries start Not Connected
  await expect(details.getByTestId("connection-email")).toHaveText("priya@acme.example");

  // status can be changed from the details, and the list follows
  await details.getByRole("combobox", { name: "Status of Priya Sharma" }).selectOption("Connected");
  await expect(page.getByRole("status").filter({ hasText: "marked as Connected" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
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

  // a second connection with a custom ("Other") role and no Company URL / designation
  await page.getByRole("button", { name: "Add connection" }).first().click();
  await add(page, valid("Rahul Verma", { company: "Globex", category: "Other", role: "Site Reliability Engineer" }));
  await page.getByRole("dialog").getByRole("button", { name: "Add connection" }).click();
  await expect(page.getByTestId("connection-row")).toHaveCount(2);
  await expect(page.getByTestId("connection-row").first().getByRole("button", { name: "Rahul Verma", exact: true })).toBeVisible(); // newest first
  expect((await dataRows(request, "Connections"))[1].slice(13, 16)).toEqual(["", "Other", "Site Reliability Engineer"]);

  // edit from the details: the SAME six fields, prefilled
  await page.getByRole("button", { name: "View Priya Sharma" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Edit Priya Sharma" }).click();
  const edit = page.getByRole("dialog", { name: "Edit connection" });
  await expect(edit).toBeVisible();
  await expect(edit.locator('label, [id$="-role-label"]')).toHaveText([/^Person Name/, /^Person Designation/, /^Person Email/, /^Company Name/, /^Company URL/, /^Role to Apply/]);
  for (const gone of [/LinkedIn/, /Other profile/, /Message to send/, /^Notes/, /^Status/]) await expect(edit.getByLabel(gone)).toHaveCount(0);
  await expect(edit.getByLabel(/^Person Email/)).toHaveValue("priya@acme.example");
  await expect(edit.getByLabel(/^Company URL/)).toHaveValue("https://acme.com/");
  await expect(roleField(edit)).toContainText("Machine Learning Engineer");
  await edit.getByLabel(/^Company Name/).fill("New Corp");
  await edit.getByLabel(/^Person Email/).fill("priya.sharma@newcorp.example");
  await roleField(edit).click();
  await expectMenuAboveAndVisible(page, edit);
  await edit.getByRole("menuitem", { name: "Data", exact: true }).click();
  await expectMenuAboveAndVisible(page, edit);
  await edit.getByRole("menuitem", { name: "Data Engineer" }).click();
  await edit.getByLabel(/^Company URL/).fill("");
  await edit.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByTestId("connection-row").filter({ hasText: "Priya Sharma" }).getByText("New Corp")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("connection-row").filter({ hasText: "Priya Sharma" }).getByTestId("connection-row-email")).toHaveText("priya.sharma@newcorp.example");
  expect((await dataRows(request, "Connections"))[0].slice(12, 16)).toEqual(["priya.sharma@newcorp.example", "", "Data", "Data Engineer"]);

  // edit from the row menu
  await page.getByRole("button", { name: "More actions: Rahul Verma" }).click();
  await page.getByRole("menuitem", { name: "Edit connection" }).click();
  await expect(page.getByRole("dialog", { name: "Edit connection" })).toBeVisible();
  await expect(page.getByRole("dialog").getByLabel("Custom role")).toHaveValue("Site Reliability Engineer");
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
  for (const tab of ["Jobs", "Applications"] as const) expect(await dataRows(request, tab)).toHaveLength(0);
});

test("a historical connection (message, notes and links, no Role to Apply) stays readable and its old data survives an edit", async ({ page, request }) => {
  const at = "2026-10-01T10:00:00.000Z";
  await appendRows(request, "Connections", [["conn_e2eold", "anni", "Old Priya", "Globex", "Recruiter", "https://www.linkedin.com/in/priya-test", "https://priya.dev", MESSAGE, "Role: Machine Learning Engineer. Met at a meetup", "Reply", at, at, "old@globex.example"]]);
  await signIn(page, "Anni", "0001");
  await open(page);
  const row = page.getByTestId("connection-row").first();
  await expect(row.getByText("Globex", { exact: true })).toBeVisible();
  await row.getByRole("button", { name: "View Old Priya" }).click();
  const details = page.getByRole("dialog", { name: "Connection details" });
  await expect(details.getByTestId("connection-message")).toHaveText(MESSAGE.replace("\n", " ").replace(/\s+/g, " "));
  await expect(details.getByText("Role: Machine Learning Engineer. Met at a meetup")).toBeVisible();
  await expect(details.getByTestId("connection-apply-role")).toHaveCount(0); // no Role to Apply saved yet
  const link = details.getByRole("link", { name: /Open profile/ });
  await expect(link).toHaveAttribute("href", "https://www.linkedin.com/in/priya-test");
  expect(await link.getAttribute("rel")).toContain("noopener");
  await details.getByRole("button", { name: "Copy message" }).click();
  await expect(details.getByRole("button", { name: "Copied" })).toBeVisible();

  // Edit: the six fields only; the role its notes named is suggested, nothing is saved until Save
  await details.getByRole("button", { name: "Edit Old Priya" }).click();
  const edit = page.getByRole("dialog", { name: "Edit connection" });
  for (const gone of [/LinkedIn/, /Message to send/, /^Notes/]) await expect(edit.getByLabel(gone)).toHaveCount(0);
  await expect(edit.getByTestId("role-suggestion")).toBeVisible();
  await expect(roleField(edit)).toContainText("Machine Learning Engineer");
  expect((await dataRows(request, "Connections"))[0]).toHaveLength(13); // nothing saved yet
  await edit.getByLabel(/^Company URL/).fill("globex.com");
  await edit.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const after = (await dataRows(request, "Connections"))[0];
  expect(after.slice(0, 12)).toEqual(["conn_e2eold", "anni", "Old Priya", "Globex", "Recruiter", "https://www.linkedin.com/in/priya-test", "https://priya.dev", MESSAGE, "Role: Machine Learning Engineer. Met at a meetup", "Reply", at, after[11]]);
  expect(after.slice(12, 16)).toEqual(["old@globex.example", "https://globex.com/", "AI/ML", "Machine Learning Engineer"]);
});

test("connections are SHARED: every member sees every entry; only the adder can edit or delete", async ({ page, browser }, info) => {
  await signIn(page, "Anni", "0001");
  await open(page);
  await page.getByRole("button", { name: "Add your first connection" }).click();
  await add(page, valid("Shared contact"));
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
  await expect(details.getByTestId("connection-apply-role")).toContainText("Software Engineer");
  await expect(details.getByTestId("connection-added-by")).toContainText("Added by Anni");
  await expect(details.getByRole("button", { name: /Edit|Delete/ })).toHaveCount(0);
  await expect(details.getByRole("combobox")).toHaveCount(0);
  await expect(details.getByText("Only Anni can edit or delete this entry.")).toBeVisible();
  await lukky.keyboard.press("Escape");
  // Lukky adds one too; Anni then sees both
  await lukky.getByRole("button", { name: "Add connection" }).first().click();
  await add(lukky, valid("Lukky's find"));
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

test("Gmail drafts are automatic: details show the drafting state (no button); everyone sees the same state", async ({ page, browser, request }, info) => {
  const at = new Date().toISOString();
  await appendRows(request, "Connections", [
    ["conn_e2eadam", "lukky", "Adam", "Evidence", "Ceo", "", "", "Hi Adam", "", "Not Connected", at, at, "adam@evidence.example"],
    ["conn_e2edone", "lukky", "Bea Done", "Globex", "CTO", "", "", "", "", "Not Connected", at, at, "bea@globex.example"],
    ["conn_e2enomail", "lukky", "No Mail", "Initech", "Founder", "", "", "", "", "Not Connected", at, at, ""],
  ]);
  // Bea: drafted in Anni's and Lukky's Gmail (Anni's already sent), Rishii's skipped (Gmail not connected).
  const d = (m: string, s: string) => [`contact:conn_e2edone:${m}`, m, "contact", "conn_e2edone", s === "skipped_unauthorized" ? "" : `gd-${m}`, s, at, "", "", ""];
  await appendRows(request, "NF_Drafts", [d("anni", "sent"), d("lukky", "created"), d("rishii", "skipped_unauthorized")]);

  await signIn(page, "Lukky", "0002");
  await goViaNav(page, "Connections", "/connections");
  const details = page.getByRole("dialog", { name: "Connection details" });

  await page.getByRole("button", { name: "View Adam" }).click();
  await expect(details.getByTestId("gmail-draft-headline")).toHaveText("Drafts will be created automatically within about 10 minutes.");
  for (const m of ["anni", "lukky", "rishii"]) await expect(details.getByTestId(`gmail-draft-${m}`)).toContainText("waiting");
  await expect(details.getByRole("button", { name: /Gmail draft/i })).toHaveCount(0); // no manual step
  await details.getByRole("button", { name: /Close/ }).first().click();

  await page.getByRole("button", { name: "View Bea Done" }).click();
  await expect(details.getByTestId("gmail-draft-headline")).toHaveText("Drafted · 2 of 3 mailboxes · 1 sent · 1 skipped");
  await expect(details.getByTestId("gmail-draft-anni")).toContainText("sent");
  await expect(details.getByTestId("gmail-draft-lukky")).toContainText("drafted");
  await expect(details.getByTestId("gmail-draft-rishii")).toContainText("Gmail not connected");
  await details.getByRole("button", { name: /Close/ }).first().click();

  await page.getByRole("button", { name: "View No Mail" }).click();
  await expect(details.getByTestId("gmail-draft-headline")).toHaveText("No email address, so no Gmail drafts.");
  await details.getByRole("button", { name: /Close/ }).first().click();
  expect((await dataRows(request, "Connections")).filter((r) => r[2] === "Adam")).toHaveLength(1);

  // Anni (not the adder) sees the same shared state; there is no endpoint to create drafts by hand.
  const other = await browser.newContext({ baseURL: info.project.use.baseURL, viewport: info.project.use.viewport ?? undefined, extraHTTPHeaders: info.project.use.extraHTTPHeaders });
  const anni = await other.newPage();
  await signIn(anni, "Anni", "0001");
  await goViaNav(anni, "Connections", "/connections");
  await anni.getByRole("button", { name: "View Bea Done" }).click();
  await expect(anni.getByRole("dialog", { name: "Connection details" }).getByTestId("gmail-draft-headline")).toHaveText("Drafted · 2 of 3 mailboxes · 1 sent · 1 skipped");
  const post = await anni.evaluate(async () => (await fetch("/api/connections/conn_e2eadam/draft", { method: "POST" })).status);
  expect(post).toBe(405);
  await other.close();
});

test("the administrator (Anni) edits and deletes a connection Lukky added; Rishii is offered nothing and is refused by the API", async ({ page, browser }, info) => {
  const ctxOpts = { baseURL: info.project.use.baseURL, viewport: info.project.use.viewport ?? undefined, extraHTTPHeaders: info.project.use.extraHTTPHeaders };
  // Lukky adds a connection
  await signIn(page, "Lukky", "0002");
  await open(page);
  await page.getByRole("button", { name: "Add your first connection" }).click();
  await add(page, valid("Lukky's contact", { category: "Data", role: "Data Engineer" }));
  await page.getByRole("dialog").getByRole("button", { name: "Add connection" }).click();
  await expect(page.getByTestId("connection-row")).toHaveCount(1);
  const id = await page.evaluate(async () => (await (await fetch("/api/connections")).json()).data[0].connectionId as string);

  // Rishii: sees it, no actions in the UI, and direct API calls are refused
  const rishiiCtx = await browser.newContext(ctxOpts);
  const rishii = await rishiiCtx.newPage();
  await signIn(rishii, "Rishii", "0003");
  await open(rishii);
  const rrow = rishii.getByTestId("connection-row");
  await expect(rrow).toHaveCount(1);
  await expect(rrow.getByRole("button", { name: /More actions/ })).toHaveCount(0);
  const refused = await rishii.evaluate(async (cid) => {
    const put = await fetch(`/api/connections/${cid}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ company: "Hijacked" }) });
    const del = await fetch(`/api/connections/${cid}`, { method: "DELETE" });
    return [put.status, del.status];
  }, id);
  expect(refused).toEqual([403, 403]);
  await rishiiCtx.close();

  // Anni (administrator): Edit and Delete are offered on Lukky's connection
  const anniCtx = await browser.newContext(ctxOpts);
  const anni = await anniCtx.newPage();
  await signIn(anni, "Anni", "0001");
  await open(anni);
  const arow = anni.getByTestId("connection-row");
  await expect(arow).toHaveCount(1);
  await expect(arow.getByTestId("connection-row-added-by")).toHaveText("Lukky");
  await anni.getByRole("button", { name: "More actions: Lukky's contact" }).click();
  await anni.getByRole("menuitem", { name: "Edit connection" }).click();
  await anni.getByRole("dialog").getByLabel(/^Company Name/).fill("Corrected Corp");
  await anni.getByRole("dialog").getByRole("button", { name: "Save changes" }).click();
  await expect(arow.getByText("Corrected Corp")).toBeVisible();
  await expect(arow.getByTestId("connection-row-added-by")).toHaveText("Lukky"); // attribution preserved
  expect((await dataRows(anni.request, "Connections"))[0][1]).toBe("lukky");

  // delete asks first
  await anni.getByRole("button", { name: "More actions: Lukky's contact" }).click();
  await anni.getByRole("menuitem", { name: "Delete connection" }).click();
  await anni.getByRole("dialog").getByRole("button", { name: "Keep" }).click();
  await expect(arow).toHaveCount(1);
  await anni.getByRole("button", { name: "More actions: Lukky's contact" }).click();
  await anni.getByRole("menuitem", { name: "Delete connection" }).click();
  await anni.getByRole("dialog").getByRole("button", { name: "Remove" }).click();
  await expect(anni.getByTestId("connection-row")).toHaveCount(0);
  await anniCtx.close();
});
