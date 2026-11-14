/** The import schedule: pause until a date, daily allowance from 00:15 local time, batches of 50 that are drafted and sent before the next. */
import { describe, expect, it } from "vitest";
import { BATCH_MAX_WAIT_MS, decideImport, windowStartOf, type ImportScheduleConfig } from "@/lib/outreach/import-schedule";
import { loadOutreachConfig } from "@/lib/outreach/config";
import { emptyDrafts, emptySendFields, type TrackingRecord } from "@/lib/outreach/types";

const TZ = "Asia/Kolkata";
const cfg: ImportScheduleConfig = { importsFrom: "2026-11-15T18:45:00.000Z", dayStart: "00:15", batchSize: 50, dailyLimit: 200 };
let n = 0;
const rec = (claimedAt: string, over: Partial<TrackingRecord> = {}): TrackingRecord => ({
  row: ++n, contactId: `c${n}`, email: `p${n}@x.example.com`, source: "outreach-database", importStatus: "added", connectionId: `conn${n}`, ownerMemberId: "anni", importDay: "",
  claimedAt, addedAt: claimedAt, attempts: 1, segment: "person-and-company", targetRole: "", roleBasis: "", processing: "drafted", drafts: emptyDrafts(), reviewReason: "",
  ...emptySendFields(), sentAt: "", lastError: "", updatedAt: claimedAt, ...over,
});
const many = (k: number, at: string, over: Partial<TrackingRecord> = {}) => Array.from({ length: k }, () => rec(at, over));

describe("the day's window opens at 00:15 IST", () => {
  it("00:15 IST is 18:45 UTC the day before; before 00:15 the previous day's window is still open", () => {
    expect(windowStartOf(new Date("2026-11-15T19:00:00Z"), TZ, "00:15").toISOString()).toBe("2026-11-15T18:45:00.000Z");
    expect(windowStartOf(new Date("2026-11-15T18:44:59Z"), TZ, "00:15").toISOString()).toBe("2026-11-14T18:45:00.000Z");
    expect(windowStartOf(new Date("2026-11-16T10:00:00Z"), TZ, "00:15").toISOString()).toBe("2026-11-15T18:45:00.000Z");
  });
});

describe("pause until 16 Nov 00:15 IST", () => {
  it("nothing is imported on 15 Nov (IST); the first batch of 50 opens at 00:15 on 16 Nov", () => {
    expect(decideImport([], new Date("2026-11-15T12:00:00Z"), TZ, cfg)).toMatchObject({ allowed: false, reason: expect.stringMatching(/paused until 2026-11-15T18:45/) });
    expect(decideImport([], new Date("2026-11-15T18:44:00Z"), TZ, cfg).allowed).toBe(false);
    expect(decideImport([], new Date("2026-11-15T18:45:00Z"), TZ, cfg)).toMatchObject({ allowed: true, take: 50, batch: 1 });
  });
  it("the production config reads the pause, start time and batch size, with 00:15 / 50 as defaults", () => {
    const c = loadOutreachConfig({ OUTREACH_IMPORTS_FROM: "2026-11-15T18:45:00Z" } as unknown as NodeJS.ProcessEnv);
    expect(c.importSchedule).toEqual({ importsFrom: "2026-11-15T18:45:00.000Z", dayStart: "00:15", batchSize: 50, dailyLimit: 200 });
    expect(loadOutreachConfig({ OUTREACH_IMPORT_DAY_START: "25:99", OUTREACH_IMPORT_BATCH: "0" } as unknown as NodeJS.ProcessEnv).importSchedule).toMatchObject({ importsFrom: "", dayStart: "00:15", batchSize: 50 });
  });
});

describe("batches of 50: import, draft and send, then the next 50", () => {
  const now = new Date("2026-11-16T02:00:00Z"); // 07:30 IST
  const at = "2026-11-15T19:00:00.000Z";

  it("a batch that is still filling is finished first (only the remainder)", () => {
    expect(decideImport(many(30, at), now, TZ, cfg)).toMatchObject({ allowed: true, take: 20, batch: 1 });
  });
  it("a full batch whose Connections are still being drafted / sent holds the next batch back", () => {
    const d = decideImport([...many(40, at, { sendStatus: "sent", processing: "sent" }), ...many(10, at, { processing: "drafting" })], now, TZ, cfg);
    expect(d).toMatchObject({ allowed: false, reason: expect.stringMatching(/10 Connections are still being drafted/) });
  });
  it("once every Connection of the batch is sent or stopped for review / blocked / failed, the next 50 follow", () => {
    const done = [...many(45, at, { sendStatus: "sent", processing: "sent" }), ...many(3, at, { sendStatus: "review" }), ...many(1, at, { sendStatus: "blocked" }), ...many(1, at, { processing: "failed" }), ...many(2, at, { importStatus: "import_failed" })];
    expect(decideImport(done, now, TZ, cfg)).toMatchObject({ allowed: true, take: 50, batch: 2 });
  });
  it(`a Connection still unfinished ${BATCH_MAX_WAIT_MS / 3_600_000} h after it was claimed no longer holds the queue`, () => {
    const old = new Date(now.getTime() - BATCH_MAX_WAIT_MS).toISOString();
    expect(decideImport([...many(49, old, { sendStatus: "sent" }), rec(old, { processing: "drafting" })], now, TZ, cfg)).toMatchObject({ allowed: true, take: 50 });
  });
  it("at most 200 per day: after four batches nothing more until the next 00:15", () => {
    const four = many(200, at, { sendStatus: "sent", processing: "sent" });
    expect(decideImport(four, now, TZ, cfg)).toMatchObject({ allowed: false, reason: expect.stringMatching(/200 imports are done/) });
    expect(decideImport(four, new Date("2026-11-16T18:45:00Z"), TZ, cfg)).toMatchObject({ allowed: true, take: 50, batch: 1 });
  });
  it("contacts linked to an existing Connection, manual Connections and earlier days do not use the allowance", () => {
    const other = [...many(10, at, { lastError: "linked-existing" }), ...many(10, at, { source: "manual" }), ...many(50, "2026-11-15T10:00:00.000Z")];
    expect(decideImport(other, now, TZ, cfg)).toMatchObject({ allowed: true, take: 50, importedInWindow: 0 });
  });
});
