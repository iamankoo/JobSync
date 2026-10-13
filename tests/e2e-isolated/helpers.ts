import { expect, type APIRequestContext, type Page } from "@playwright/test";

export const MEMBERS = [
  { id: "anni", name: "Anni", code: "0001", accent: "rgb(37, 99, 235)" },
  { id: "lukky", name: "Lukky", code: "0002", accent: "rgb(245, 197, 24)" },
  { id: "rishii", name: "Rishii", code: "0003", accent: "rgb(225, 29, 72)" },
] as const;
export type MemberKey = (typeof MEMBERS)[number]["id"];

// ---------- simulated time (everything is relative to the real clock, shifted by whole hours/days)
export const hoursAgoIso = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
export const daysAgoIso = (d: number) => hoursAgoIso(d * 24);
/** Today's calendar date in the app timezone (APP_TIMEZONE = Asia/Kolkata for this suite). */
export const todayIst = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
export function dateOffset(days: number): string {
  const [y, m, d] = todayIst().split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// ---------- the guarded test seed route (exists only on the in-memory test backend)
async function seed(request: APIRequestContext, data: Record<string, unknown>) {
  const res = await request.post("/api/test/seed", { data });
  expect(res.status(), `seed ${JSON.stringify(data).slice(0, 80)}`).toBe(200);
  return res.json();
}
export const resetStore = (request: APIRequestContext) => seed(request, { action: "reset" });
export const appendRows = (request: APIRequestContext, tab: string, rows: string[][]) => seed(request, { action: "append", tab, rows });
export const updateRows = (request: APIRequestContext, tab: string, where: Record<string, string>, set: Record<string, string>) =>
  seed(request, { action: "update", tab, where, set });
/** Raw spreadsheet rows (header first) as persisted by the app. */
export async function dumpTab(request: APIRequestContext, tab: "Jobs" | "Applications" | "Members" | "Activity"): Promise<string[][]> {
  return (await seed(request, { action: "dump", tab })).rows;
}
export async function dataRows(request: APIRequestContext, tab: "Jobs" | "Applications" | "Members" | "Activity") {
  return (await dumpTab(request, tab)).slice(1);
}

// ---------- row builders (same column order as the real sheet)
export function jobRow(n: number | string, over: Partial<Record<"company" | "role" | "type" | "mode" | "exp" | "pay" | "loc" | "deadline" | "by" | "addedAt" | "desc" | "url", string>> = {}): string[] {
  return [
    `job_e2e${n}`, over.company ?? `E2E Test Co ${n}`, over.role ?? `E2E Test Role ${n}`, over.type ?? (Number(n) % 2 ? "Full-time" : "Internship"),
    over.mode ?? "", over.exp ?? (Number(n) % 2 ? "1–3 years" : "0–1 years"), over.pay ?? `Test pay ${n}`, over.loc ?? (Number(n) % 3 ? "Testville" : "Sampleton"),
    over.url ?? `https://jobs.example.test/e2e/${n}`, over.deadline ?? "", over.desc ?? `Synthetic description ${n}`, over.by ?? "anni", over.addedAt ?? hoursAgoIso(2),
  ];
}
export function appRow(jobN: number | string, member: MemberKey, status: string, appliedAt: string, over: { stage?: string; notes?: string; answer?: string; answeredAt?: string } = {}): string[] {
  return [`job_e2e${jobN}`, member, status, appliedAt, over.stage ?? "", over.notes ?? "", appliedAt, over.answer ?? "", over.answeredAt ?? ""];
}
export function activityRow(n: number, member: MemberKey, action: string, daysBack: number, jobN?: number): string[] {
  const ts = daysAgoIso(daysBack);
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ts));
  return [`act_e2e${n}`, member, date, action, jobN ? `job_e2e${jobN}` : "", ts];
}

/** A realistic synthetic data set for layout checks: many jobs, applications at several stages, deadlines, activity. */
export async function seedRealisticData(request: APIRequestContext) {
  await resetStore(request);
  const who: MemberKey[] = ["anni", "lukky", "rishii"];
  const jobs = Array.from({ length: 14 }, (_, i) => {
    const n = i + 1;
    return jobRow(n, {
      by: who[i % 3],
      addedAt: hoursAgoIso(3 + i * 7),
      deadline: n % 4 === 0 ? "" : dateOffset(n - 3), // some past, some today, some upcoming, some missing
      desc: "Synthetic description. ".repeat(6),
      company: i % 5 === 0 ? "A Synthetic Company With A Rather Long Name Incorporated" : undefined,
      role: i % 4 === 0 ? "Senior Staff Software Development Engineer In Test (Synthetic)" : undefined,
    });
  });
  await appendRows(request, "Jobs", jobs);
  await appendRows(request, "Applications", [
    appRow(1, "anni", "Applied", daysAgoIso(3)),
    appRow(2, "anni", "In Progress", daysAgoIso(5), { stage: "Screening", notes: "Synthetic note" }),
    appRow(3, "anni", "Interview", daysAgoIso(9), { answer: "Interview", answeredAt: daysAgoIso(2) }),
    appRow(5, "anni", "Applied", daysAgoIso(4), { stage: "Shortlisted", answer: "Shortlisted", answeredAt: daysAgoIso(1) }),
    appRow(6, "anni", "Offer", daysAgoIso(12), { stage: "Offer" }),
    appRow(7, "anni", "Rejected", daysAgoIso(15)),
    appRow(1, "lukky", "Applied", daysAgoIso(2)),
    appRow(2, "rishii", "Interview", daysAgoIso(6)),
  ]);
  const acts: string[][] = [];
  let n = 1;
  for (const back of [0, 0, 0, 1, 1, 2, 4, 4, 4, 4, 9, 15, 15, 22, 30, 41, 55, 70]) acts.push(activityRow(n++, "anni", back % 3 ? "job_added" : "job_applied", back, 1));
  acts.push(activityRow(n++, "anni", "visit", 0), activityRow(n++, "anni", "login", 3), activityRow(n++, "lukky", "job_added", 1, 2));
  await appendRows(request, "Activity", acts);
}

// ---------- UI helpers
export async function signIn(page: Page, name: string, code: string, options: { keepNotificationOnboarding?: boolean } = {}) {
  // The notification onboarding dialog (a modal, by design) is dismissed up front so the older specs, which are not
  // about notifications, can use the Dashboard. notifications.spec.ts opts out to test the dialog itself.
  if (!options.keepNotificationOnboarding) {
    await page.addInitScript(() => {
      try {
        for (const id of ["anni", "lukky", "rishii"]) sessionStorage.setItem(`jobsync:push-onboarding:${id}`, "1");
      } catch {
        /* ignore */
      }
    });
  }
  await page.goto("/login");
  await page.getByRole("button", { name, exact: true }).click();
  await page.getByLabel(`Access code for ${name}`).fill(code);
  await page.getByRole("button", { name: "Open Dashboard" }).click();
  await page.waitForURL("**/dashboard");
}

/** Navigates through the real sidebar (opening the mobile drawer when the sidebar is collapsed). */
export async function goViaNav(page: Page, label: string, path: string) {
  const menu = page.getByRole("button", { name: "Open menu" });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: label, exact: true }).click();
  await page.waitForURL(`**${path}`);
}

export async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

/** Elements (outside intentional scroll containers) whose box sticks out of the viewport horizontally. */
export async function elementsOutsideViewport(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out: string[] = [];
    const scrollable = (el: Element | null): boolean => {
      for (let e = el; e && e !== document.body; e = e.parentElement) {
        const s = getComputedStyle(e);
        if ((s.overflowX === "auto" || s.overflowX === "scroll" || s.overflowX === "hidden") && (e as HTMLElement).clientWidth < (e as HTMLElement).scrollWidth) return true;
        if (s.position === "fixed" || s.position === "sticky") return false;
      }
      return false;
    };
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none" || style.position === "fixed") continue;
      if ((r.right > vw + 1 || r.left < -1) && !scrollable(el.parentElement)) {
        out.push(`${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? "." + el.className.split(" ")[0] : ""} (${Math.round(r.left)}..${Math.round(r.right)} of ${vw})`);
        if (out.length >= 8) break;
      }
    }
    return out;
  });
}
