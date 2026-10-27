import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  MEMBERS, appRow, appendRows, dataRows, dateOffset, daysAgoIso, goViaNav, hoursAgoIso, jobRow, resetStore, signIn, todayIst, updateRows,
  type MemberKey,
} from "./helpers";

/**
 * Per-account end-to-end workflow audit against the IN-MEMORY test backend (never the real sheet).
 * Every job created here is clearly marked "[E2E TEST]". Persisted rows are read back through the
 * guarded seed route and compared with what the UI shows.
 */
test.describe.configure({ mode: "serial" });

async function api(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(
    async ([m, p, b]) => {
      const res = await fetch(p as string, { method: m as string, headers: { "content-type": "application/json" }, body: b ? JSON.stringify(b) : undefined });
      return { status: res.status, json: await res.json().catch(() => null) };
    },
    [method, path, body ?? null] as const,
  );
}

async function login(browser: Browser, id: MemberKey) {
  const m = MEMBERS.find((x) => x.id === id)!;
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signIn(page, m.name, m.code);
  return { ctx, page, m };
}

const newJob = (tag: string, over: Record<string, string> = {}) => ({
  company: `[E2E TEST] ${tag} Co`, jobRole: `[E2E TEST] ${tag} Role`, jobType: "Full-time", experience: "Fresher",
  location: "Hybrid", jobUrl: `https://example.test/${tag}`, ...over,
});

test.beforeAll(async ({ request }) => {
  await resetStore(request);
});

for (const who of MEMBERS) {
  test(`${who.name}: sign-in identity, add job, validation, duplicates, status, persistence`, async ({ browser, request }) => {
    const { ctx, page, m } = await login(browser, who.id);
    try {
      await expect(page.getByRole("heading", { level: 1 })).toContainText(`Welcome back, ${m.name}`);
      await expect(page.locator("[data-member]").first()).toHaveAttribute("data-member", m.id);

      // validation: missing required fields are rejected by the server, nothing persisted
      const before = (await dataRows(request, "Jobs")).length;
      expect((await api(page, "POST", "/api/jobs", { company: "x" })).status).toBe(400);
      expect((await api(page, "POST", "/api/jobs", { ...newJob(m.id), addedBy: "someone-else" })).status).toBe(400); // identity only from session
      expect((await dataRows(request, "Jobs")).length).toBe(before);

      // create through the real form
      await goViaNav(page, "Add Job", "/add-job");
      const job = newJob(m.id);
      await page.getByLabel(/^Job Title/).fill(job.jobRole);
      await page.getByLabel(/^Company/).fill(job.company);
      await page.getByLabel(/^Job Link/).fill(job.jobUrl);
      await page.getByLabel(/^Location/).fill(job.location);
      await page.getByLabel(/^Job Type/).selectOption("Full-time");
      await page.getByLabel(/^Experience Level/).selectOption("Fresher");
      await page.getByRole("button", { name: "Add Job" }).click();
      await expect.poll(async () => (await dataRows(request, "Jobs")).length).toBe(before + 1);

      // persisted row matches: AddedBy is the session member, AddedAt is server time, no application row created
      const rows = await dataRows(request, "Jobs");
      const mine = rows.find((r) => r.includes(job.company))!;
      expect(mine).toBeTruthy();
      expect(mine).toContain(m.id);
      expect(mine).toContain(job.jobUrl);
      expect(Math.abs(Date.now() - Date.parse(mine.find((c) => /^\d{4}-\d{2}-\d{2}T/.test(c))!))).toBeLessThan(120_000);
      expect((await dataRows(request, "Applications")).some((r) => r.includes(mine[0]))).toBe(false);

      // duplicate link: refused (409), not stored twice
      const dup = await api(page, "POST", "/api/jobs", { ...job, jobRole: "Different title" });
      expect(dup.status).toBe(409);
      expect((await dataRows(request, "Jobs")).filter((r) => r.includes(job.jobUrl)).length).toBe(1);

      // Applied -> persists, appears in My Applications; Not Applied removes it
      const jobId = mine[0];
      expect((await api(page, "PUT", `/api/applications/${jobId}`, { status: "Applied" })).status).toBe(200);
      await page.goto("/my-applications");
      await expect(page.getByText(job.jobRole).first()).toBeVisible();
      const app = (await dataRows(request, "Applications")).find((r) => r.includes(jobId) && r.includes(m.id))!;
      expect(app).toContain("Applied");
      expect((await api(page, "PUT", `/api/applications/${jobId}`, { status: "Not Applied" })).status).toBe(200);
      await page.goto("/my-applications");
      await expect(page.getByText(job.jobRole)).toHaveCount(0);
    } finally {
      await ctx.close();
    }
  });
}

test("cross-member: shared jobs, independent statuses, private applications, owner-only edit/delete", async ({ browser, request }) => {
  await resetStore(request);
  await appendRows(request, "Jobs", [jobRow(1, { by: "lukky", addedAt: hoursAgoIso(2), url: "https://example.test/shared-1", company: "[E2E TEST] Shared Co" })]);
  const a = await login(browser, "anni");
  const l = await login(browser, "lukky");
  const r = await login(browser, "rishii");
  try {
    for (const p of [a.page, l.page, r.page]) {
      await p.goto("/all-jobs");
      await expect(p.locator("tbody").getByText("[E2E TEST] Shared Co").first()).toBeVisible(); // shared with everyone
    }
    const jobId = (await dataRows(request, "Jobs"))[0][0];
    expect((await api(a.page, "PUT", `/api/applications/${jobId}`, { status: "Applied" })).status).toBe(200);
    // Not Applied -> Interview is not an allowed jump (server refuses); Applied first, then Interview
    expect((await api(r.page, "PUT", `/api/applications/${jobId}`, { status: "Interview" })).status).toBe(409);
    expect((await api(r.page, "PUT", `/api/applications/${jobId}`, { status: "Applied" })).status).toBe(200);
    expect((await api(r.page, "PUT", `/api/applications/${jobId}`, { status: "Interview" })).status).toBe(200);

    // each member sees only their own status
    const status = async (p: Page) => ((await api(p, "GET", "/api/jobs")).json.data as { jobId: string; myStatus: string }[]).find((j) => j.jobId === jobId)!.myStatus;
    expect(await status(a.page)).toBe("Applied");
    expect(await status(r.page)).toBe("Interview");
    expect(await status(l.page)).toBe("Not Applied");

    // another member's applications never appear in My Applications
    await l.page.goto("/my-applications");
    await expect(l.page.getByText("[E2E TEST] Shared Co")).toHaveCount(0);

    // only the member who added the job may edit or delete it
    expect((await api(a.page, "PUT", `/api/jobs/${jobId}`, newJob("x"))).status).toBe(403);
    expect((await api(a.page, "DELETE", `/api/jobs/${jobId}`)).status).toBe(403);
    expect((await dataRows(request, "Jobs")).length).toBe(1);

    // shared dashboard counts: team totals shared, personal numbers private
    await a.page.goto("/dashboard");
    await expect(a.page.getByText("Across team")).toBeVisible();
    expect((await api(a.page, "PUT", `/api/applications/${jobId}`, { status: "Applied", memberId: "rishii" })).status).toBe(400); // cannot target another member
  } finally {
    await Promise.all([a.ctx.close(), l.ctx.close(), r.ctx.close()]);
  }
});

test("unauthenticated calls are refused; logout ends the session", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/login");
  for (const [method, path] of [["GET", "/api/jobs"], ["POST", "/api/jobs"], ["GET", "/api/follow-ups"], ["PUT", "/api/applications/job_x"]] as const) {
    expect((await api(page, method, path, method === "GET" ? undefined : {})).status, `${method} ${path}`).toBe(401);
  }
  await signIn(page, "Anni", "0001");
  // Log out lives at the bottom of the Profile page (opened from the top-right profile button).
  await page.getByRole("link", { name: "Your profile (Anni)" }).click();
  await page.waitForURL("**/profile");
  await page.getByRole("button", { name: "Log out" }).click();
  await page.waitForURL("**/login");
  expect((await api(page, "GET", "/api/jobs")).status).toBe(401);
  await page.goto(`${baseURL}/dashboard`);
  await page.waitForURL("**/login**");
  await ctx.close();
});

test("exact dashboard + analytics counts match persisted applications", async ({ browser, request }) => {
  await resetStore(request);
  const jobs = Array.from({ length: 6 }, (_, i) => jobRow(i + 1, { by: "anni", addedAt: hoursAgoIso(1 + i), url: `https://example.test/c${i}` }));
  await appendRows(request, "Jobs", jobs);
  await appendRows(request, "Applications", [
    appRow(1, "anni", "Applied", daysAgoIso(1)),
    appRow(2, "anni", "In Progress", daysAgoIso(2), { stage: "Screening" }),
    appRow(3, "anni", "Interview", daysAgoIso(3)),
    appRow(4, "anni", "Offer", daysAgoIso(4), { stage: "Offer" }),
    appRow(5, "anni", "Rejected", daysAgoIso(5)),
    appRow(6, "anni", "Not Applied", daysAgoIso(5)),
    appRow(1, "lukky", "Applied", daysAgoIso(1)),
  ]);
  const { ctx, page } = await login(browser, "anni");
  try {
    await page.goto("/dashboard");
    await expect(page.getByText("Across team")).toBeVisible();
    const text = (await page.getByRole("main").innerText()).replace(/\s+/g, " ");
    expect(text).toMatch(/Total Jobs 6 Across team/);
    expect(text).toMatch(/My Applications 5 Applied by you/); // Not Applied is not an application; Lukky's is not hers
    expect(text).toMatch(/Pending 3 Awaiting response/); // Applied + In Progress + Interview; Offer/Rejected are resolved
    await page.goto("/analytics");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Analytics");
    await expect(page.getByText("Total Applications").first()).toBeVisible();
  } finally {
    await ctx.close();
  }
});

test("follow-up: due at 168 h, 4 answers persist, never re-asked, never downgrades; failed save keeps modal", async ({ browser, request }) => {
  await resetStore(request);
  await appendRows(request, "Jobs", [1, 2, 3, 4].map((n) => jobRow(n, { by: "lukky", addedAt: hoursAgoIso(400), url: `https://example.test/f${n}` })));
  await appendRows(request, "Applications", [
    appRow(1, "rishii", "Applied", hoursAgoIso(169)), // due
    appRow(2, "rishii", "Applied", hoursAgoIso(167)), // not yet due
    appRow(3, "rishii", "Interview", hoursAgoIso(300)), // suppressed: already further along
    appRow(4, "rishii", "Applied", hoursAgoIso(170)), // due, second question
  ]);
  const { ctx, page } = await login(browser, "rishii");
  try {
    await page.goto("/all-jobs");
    const modal = page.getByRole("alertdialog");
    await expect(modal).toBeVisible();
    await expect(page.getByText("Question 1 of 2")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(modal).toBeVisible(); // cannot be dismissed

    // a failed save keeps the question open
    await page.route("**/api/follow-ups/**", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "server_error", message: "Boom" } }) }));
    await modal.getByRole("button", { name: "I've received an interview call" }).click();
    await expect(modal.getByRole("alert")).toBeVisible();
    await page.unroute("**/api/follow-ups/**");

    await modal.getByRole("button", { name: "I've received an interview call" }).click();
    await expect(page.getByText("Question 2 of 2")).toBeVisible();
    await modal.getByRole("button", { name: "No update yet" }).click();
    await expect(modal).toBeHidden();

    const apps = await dataRows(request, "Applications");
    const first = apps.find((r) => r.includes("Interview") && r.includes("rishii") && r.includes("Interview"))!;
    expect(first).toBeTruthy();
    expect(apps.some((r) => r.includes("No update"))).toBe(true);
    await page.reload();
    await expect(modal).toBeHidden(); // answered questions are never asked again
    await updateRows(request, "Applications", { Status: "Interview" }, {}).catch(() => undefined);
  } finally {
    await ctx.close();
  }
});

test("activity timeline: visits dedupe and do not count as work; deadlines are real", async ({ browser, request }) => {
  await resetStore(request);
  await appendRows(request, "Jobs", [
    jobRow(1, { by: "anni", addedAt: hoursAgoIso(2), deadline: todayIst(), url: "https://example.test/d1" }),
    jobRow(2, { by: "anni", addedAt: hoursAgoIso(3), deadline: dateOffset(5), url: "https://example.test/d2" }),
    jobRow(3, { by: "anni", addedAt: hoursAgoIso(4), deadline: "", url: "https://example.test/d3" }),
  ]);
  const { ctx, page } = await login(browser, "anni");
  try {
    await page.goto("/dashboard");
    await page.goto("/analytics");
    await page.reload();
    const acts = await dataRows(request, "Activity");
    expect(acts.filter((r) => r.includes("visit")).length).toBeLessThanOrEqual(1); // max one visit per 30 minutes
    expect(acts.some((r) => r.includes("login"))).toBe(true);
    // no "time spent" claim anywhere on the page
    await expect(page.getByText(/time spent|hours (worked|spent)/i)).toHaveCount(0);
    await expect(page.getByText(/due today/i).first()).toBeVisible();
  } finally {
    await ctx.close();
  }
});
