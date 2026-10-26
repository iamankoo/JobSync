import { describe, expect, it, vi } from "vitest";
import { loadSheetsConfig, normalizePrivateKey } from "@/lib/google-sheets/config";
import { mapGoogleError, withRetry } from "@/lib/google-sheets/client";
import { SheetsError } from "@/lib/google-sheets/errors";
import { columnLetter, rowRange, tableRange, TABS } from "@/lib/google-sheets/schema";
import { googleError } from "../helpers/fake-sheets";

const KEY = "-----BEGIN PRIVATE KEY-----\nTESTKEYTESTKEY\n-----END PRIVATE KEY-----\n";
const good = {
  GOOGLE_SHEETS_SPREADSHEET_ID: "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
  GOOGLE_SERVICE_ACCOUNT_EMAIL: "svc@proj.iam.gserviceaccount.com",
  GOOGLE_PRIVATE_KEY: KEY.replace(/\n/g, "\\n"),
} as unknown as NodeJS.ProcessEnv;

describe("loadSheetsConfig", () => {
  it("loads valid config and restores escaped newlines / strips quotes", () => {
    const c = loadSheetsConfig(good);
    expect(c.privateKey).toBe(KEY);
    expect(normalizePrivateKey(`"${KEY.replace(/\n/g, "\\n")}"`)).toBe(KEY);
  });

  it("reports every missing variable by name only", () => {
    try {
      loadSheetsConfig({} as NodeJS.ProcessEnv);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SheetsError);
      const err = e as SheetsError;
      expect(err.code).toBe("not_configured");
      expect(err.publicMessage).toContain("GOOGLE_SHEETS_SPREADSHEET_ID");
      expect(err.publicMessage).toContain("GOOGLE_SERVICE_ACCOUNT_EMAIL");
      expect(err.publicMessage).toContain("GOOGLE_PRIVATE_KEY");
    }
  });

  it("rejects malformed values without echoing them", () => {
    const bad = { ...good, GOOGLE_SHEETS_SPREADSHEET_ID: "short", GOOGLE_PRIVATE_KEY: "SUPER-SECRET-not-a-key" } as unknown as NodeJS.ProcessEnv;
    try {
      loadSheetsConfig(bad);
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as SheetsError;
      expect(err.code).toBe("not_configured");
      expect(err.publicMessage).toContain("GOOGLE_PRIVATE_KEY");
      expect(err.publicMessage).not.toContain("SUPER-SECRET");
      expect(err.message).not.toContain("SUPER-SECRET");
    }
    expect(() => loadSheetsConfig({ ...good, GOOGLE_SERVICE_ACCOUNT_EMAIL: "nope" } as unknown as NodeJS.ProcessEnv)).toThrow(/GOOGLE_SERVICE_ACCOUNT_EMAIL/);
  });
});

describe("mapGoogleError", () => {
  const cases: [string, unknown, string][] = [
    ["401", googleError(401), "auth_failed"],
    ["403 permission", googleError(403, "forbidden"), "permission_denied"],
    ["403 quota", googleError(403, "rateLimitExceeded"), "rate_limited"],
    ["404", googleError(404), "spreadsheet_not_found"],
    ["429", googleError(429), "rate_limited"],
    ["400 bad range", googleError(400), "schema_invalid"],
    ["500", googleError(500), "upstream_error"],
    ["503", googleError(503), "upstream_error"],
    ["timeout", Object.assign(new Error("t"), { code: "ETIMEDOUT" }), "timeout"],
    ["network", Object.assign(new Error("n"), { code: "ECONNRESET" }), "upstream_error"],
    ["non-error", "boom", "upstream_error"],
  ];
  it.each(cases)("%s -> %s", (_n, err, code) => {
    expect(mapGoogleError(err).code).toBe(code);
  });

  it("never copies upstream details into the public message", () => {
    for (const [, err] of cases) expect(mapGoogleError(err).publicMessage).not.toContain("SECRET-DETAIL");
  });
});

describe("withRetry", () => {
  it("retries transient failures with exponential backoff, then succeeds", async () => {
    const sleeps: number[] = [];
    const op = vi.fn().mockRejectedValueOnce(googleError(429)).mockRejectedValueOnce(googleError(503)).mockResolvedValue("ok");
    // random() = 0.5 removes the jitter: quota waits start at 1 s, other transient waits at 0.5 s.
    expect(await withRetry(op, async (ms) => void sleeps.push(ms), { random: () => 0.5 })).toBe("ok");
    expect(op).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([1000, 1000]);
  });

  it("gives up after the maximum attempts with a mapped error", async () => {
    const op = vi.fn().mockRejectedValue(googleError(429));
    await expect(withRetry(op, async () => {})).rejects.toMatchObject({ code: "rate_limited" });
    expect(op).toHaveBeenCalledTimes(5);
    const op5xx = vi.fn().mockRejectedValue(googleError(503));
    await expect(withRetry(op5xx, async () => {})).rejects.toMatchObject({ code: "upstream_error" });
    expect(op5xx).toHaveBeenCalledTimes(3);
  });

  it("does not retry permanent failures", async () => {
    const op = vi.fn().mockRejectedValue(googleError(403, "forbidden"));
    await expect(withRetry(op, async () => {})).rejects.toMatchObject({ code: "permission_denied" });
    expect(op).toHaveBeenCalledTimes(1);
  });
});

describe("schema helpers", () => {
  it("builds A1 ranges for each tab", () => {
    expect(columnLetter(1)).toBe("A");
    expect(columnLetter(13)).toBe("M");
    expect(columnLetter(27)).toBe("AA");
    expect(tableRange("jobs")).toBe("Jobs!A:M");
    expect(tableRange("applications")).toBe("Applications!A:I"); // 7 required + 2 optional follow-up columns
    expect(tableRange("members")).toBe("Members!A:D");
    expect(tableRange("activity")).toBe("Activity!A:F");
    expect(rowRange("applications", 5)).toBe("Applications!A5:I5");
  });

  it("keeps the exact column order from the spec", () => {
    expect([...TABS.jobs.headers]).toEqual(["JobID", "Company", "JobRole", "JobType", "WorkMode", "Experience", "StipendSalary", "Location", "JobURL", "Deadline", "Description", "AddedBy", "AddedAt"]);
    expect([...TABS.applications.headers]).toEqual(["JobID", "MemberID", "Status", "AppliedAt", "ApplicationStage", "Notes", "LastUpdated"]);
    expect([...TABS.members.headers]).toEqual(["MemberID", "Name", "Photo", "Active"]);
    expect([...TABS.activity.headers]).toEqual(["ActivityID", "MemberID", "Date", "Action", "JobID", "Timestamp"]);
  });
});
