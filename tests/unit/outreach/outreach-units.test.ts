import { afterEach, describe, expect, it, vi } from "vitest";
import { MEMBER_IDS, type MemberId } from "@/config/members";
import { MEMBER_RESUME_FILES, RESUME_KINDS, planResume, resumeKindForRole, type ResumeUpload } from "@/config/resume-map";
import { FALLBACK_COMPANY, FALLBACK_SALUTATION, isFallbackCompany } from "@/config/outreach-wording";
import { loadOutreachConfig } from "@/lib/outreach/config";
import { companyReferenceFor, fallbacksConsistent, firstInDuplicateGroups, importEligibility, importOrder, parseMasterRows, salutationFor, segmentOf } from "@/lib/outreach/contacts";
import { connectionInputFor } from "@/lib/outreach/importer";
import { attemptSend, evaluateSendEligibility, type DraftFacts, type Mailer } from "@/lib/outreach/send-gate";
import { computeCounters, deriveProcessing, draftKeyFor, resumeFromDetail, type LedgerEntry } from "@/lib/outreach/sync";
import { SENDING_ENABLED, DAILY_IMPORT_LIMIT, emptyDrafts, emptySendFields, type OutreachContact, type TrackingRecord } from "@/lib/outreach/types";
import { createConnectionSchema } from "@/lib/validation/connections";
import { applyRoleProblem } from "@/lib/connections/apply-role";
import { masterGrid, masterRow } from "../../helpers/outreach";

const pdf = (name: string): ResumeUpload => ({ fileName: name, mimeType: "application/pdf" });
const ALL = (m: MemberId) => Object.values(MEMBER_RESUME_FILES[m]).map((f) => pdf(f!));

describe("resume mapping for all three members", () => {
  it("target role -> resume kind", () => {
    const cases: [string, string][] = [
      ["AI/ML Engineer", "AIML"], ["AI Engineer", "AIML"], ["Applied AI Engineer", "AIML"], ["Machine Learning Engineer", "AIML"], ["Agentic AI Engineer", "AIML"],
      ["Software Engineer", "SDE"], ["Software Developer", "SDE"], ["Backend Engineer", "SDE"], ["Python Developer", "SDE"], ["App Developer", "SDE"], ["SDE", "SDE"],
      ["Front End Developer", "WebD"], ["Full Stack Engineer", "WebD"], ["Web Developer", "WebD"], ["MERN Stack Engineer", "WebD"],
      ["DevOps Engineer", "DevOps"], ["Site Reliability Engineer", "DevOps"],
      ["Data Engineer", "Data"], ["Data Scientist", "Data"], ["Data Analyst", "Data"],
      ["Some Totally Custom Role", "SDE"], ["Data Entry", "SDE"], ["", "SDE"],
    ];
    for (const [role, kind] of cases) expect(resumeKindForRole(role), role).toBe(kind);
  });

  it("REPORT: the available and missing mapping per member (as of the 3 Nov 2026 upload inventory)", () => {
    const have = (m: MemberId) => RESUME_KINDS.filter((k) => MEMBER_RESUME_FILES[m][k]);
    const missing = (m: MemberId) => RESUME_KINDS.filter((k) => !MEMBER_RESUME_FILES[m][k]);
    expect(have("anni")).toEqual(["AIML", "SDE", "WebD", "DevOps", "Data"]);
    expect(missing("anni")).toEqual([]);
    expect(have("lukky")).toEqual(["AIML", "SDE"]);
    expect(missing("lukky")).toEqual(["WebD", "DevOps", "Data"]);
    expect(have("rishii")).toEqual(["AIML", "SDE"]);
    expect(missing("rishii")).toEqual(["WebD", "DevOps", "Data"]);
    // every member has an SDE resume, so the fallback is always available when the uploads are intact
    for (const m of MEMBER_IDS) expect(MEMBER_RESUME_FILES[m].SDE).toBeTruthy();
  });

  it("each member's mapped files carry that member's own naming; no file is shared between members", () => {
    const all = MEMBER_IDS.flatMap((m) => Object.values(MEMBER_RESUME_FILES[m]).map((f) => f!.toLowerCase()));
    expect(new Set(all).size).toBe(all.length);
    for (const f of Object.values(MEMBER_RESUME_FILES.anni)) expect(f).toMatch(/^Aniket/);
    for (const f of Object.values(MEMBER_RESUME_FILES.lukky)) expect(f).toMatch(/^Lakshya/);
    for (const f of Object.values(MEMBER_RESUME_FILES.rishii)) expect(f).toMatch(/^Rishi/);
  });

  it("uses the specialised resume when it exists", () => {
    expect(planResume("anni", "Data Analyst", ALL("anni"))).toEqual({ status: "use", kind: "Data", fileName: "Aniket_Raj_Data.pdf" });
    expect(planResume("lukky", "AI Engineer", ALL("lukky"))).toEqual({ status: "use", kind: "AIML", fileName: "Lakshya_AiMl.pdf" });
    expect(planResume("rishii", "Backend Engineer", ALL("rishii"))).toEqual({ status: "use", kind: "SDE", fileName: "Rishi_Raj_SDE.pdf" });
  });

  it("falls back to the SAME member's SDE resume when the specialised one is unavailable (never another member's)", () => {
    const d = planResume("lukky", "Full Stack Engineer", ALL("lukky"));
    expect(d).toMatchObject({ status: "use", kind: "SDE", fileName: "Lakshya_SDE.pdf", fallbackFrom: "WebD" });
    // a specialised file that is mapped but not uploaded
    const noAiml = ALL("rishii").filter((u) => u.fileName !== "Rishi_Raj_AIML.pdf");
    expect(planResume("rishii", "AI Engineer", noAiml)).toMatchObject({ status: "use", fileName: "Rishi_Raj_SDE.pdf", fallbackFrom: "AIML" });
    // another member's identically named upload is never considered for this member's role
    expect(planResume("anni", "Software Engineer", [pdf("Lakshya_SDE.pdf"), pdf("Rishi_Raj_SDE.pdf")])).toMatchObject({ status: "none" });
  });

  it("no SDE resume at all -> no attachment (the draft is still created and flagged)", () => {
    const d = planResume("anni", "DevOps Engineer", [pdf("Aniket_Raj_WebD.pdf")]);
    expect(d.status).toBe("none");
    expect(d.status === "none" && d.reason).toMatch(/SDE fallback also unavailable/);
    expect(planResume("rishii", "Software Engineer", []).status).toBe("none");
  });

  it("ambiguous (duplicate-named) and non-PDF uploads are never chosen", () => {
    expect(planResume("anni", "Software Engineer", [pdf("Aniket_Raj_SDE.pdf"), pdf("aniket_raj_sde.pdf")]).status).toBe("none");
    expect(planResume("anni", "Software Engineer", [{ fileName: "Aniket_Raj_SDE.pdf", mimeType: "application/msword" }]).status).toBe("none");
    // ambiguous specialised -> same member's unambiguous SDE
    expect(planResume("anni", "AI Engineer", [pdf("Aniket-Raj-AIML.pdf"), pdf("Aniket-Raj-AIML.pdf"), pdf("Aniket_Raj_SDE.pdf")])).toMatchObject({ status: "use", fileName: "Aniket_Raj_SDE.pdf" });
    // file names match case-insensitively but exactly otherwise: a near-miss is not a match
    expect(planResume("anni", "Software Engineer", [pdf("Aniket_Raj_SDE_v2.pdf"), pdf("Aniket_Raj_AI_2.pdf")]).status).toBe("none");
  });
});

const contact = (over: Partial<OutreachContact> = {}): OutreachContact => ({
  contactId: "HRC-000000000001", personName: "Jane Doe", personDesignation: "HR Manager", personEmail: "jane@acme.example.com", companyName: "Acme", companyUrl: "https://acme.example.com",
  companyDescription: "Acme builds things.", primaryRoleCategory: "Software Engineer", roleBasis: "default-fallback", roleVerificationStatus: "Unverified", companyVerificationStatus: "Verified",
  contactKind: "person", emailKind: "company", duplicateGroup: "", salutationName: "Jane Doe", companyReference: "Acme", sheetRow: 2, ...over,
});

describe("segments, fallback wording and the Connections input", () => {
  it("classifies the four contact-quality segments from the ORIGINAL names", () => {
    expect(segmentOf(contact())).toBe("person-and-company");
    expect(segmentOf(contact({ personName: "" }))).toBe("company-only");
    expect(segmentOf(contact({ companyName: "" }))).toBe("person-only");
    expect(segmentOf(contact({ personName: "", companyName: "" }))).toBe("neither");
    expect(segmentOf(contact({ personName: "   ", companyName: " " }))).toBe("neither");
  });

  it("Hiring Team / your company only when the name is missing", () => {
    expect(salutationFor(contact())).toBe("Jane Doe");
    expect(salutationFor(contact({ personName: "" }))).toBe(FALLBACK_SALUTATION);
    expect(companyReferenceFor(contact())).toBe("Acme");
    expect(companyReferenceFor(contact({ companyName: "" }))).toBe(FALLBACK_COMPANY);
    expect(isFallbackCompany(" Your Company ")).toBe(true);
    expect(isFallbackCompany("Acme")).toBe(false);
    expect(fallbacksConsistent(contact())).toBe(true);
    expect(fallbacksConsistent(contact({ personName: "", salutationName: "Jane Doe" }))).toBe(false); // stored fallback disagrees
  });

  it("the Connections input is valid for every approved role category and keeps fallback wording out of the company field", () => {
    const cats = ["Data Analyst", "Data Engineer", "AI Engineer", "AI/ML Engineer", "AI Applied Engineer", "Python Developer", "Backend Engineer", "Front End Developer / Engineer", "Full Stack Engineer", "Software Developer Engineer", "Software Engineer", "App Developer", "MERN Stack Engineer"];
    for (const c of cats) {
      const input = connectionInputFor(contact({ primaryRoleCategory: c }));
      expect(() => createConnectionSchema.parse(input), c).not.toThrow();
      expect(applyRoleProblem(input.roleCategory, input.applyRole), c).toBeNull();
    }
    const none = connectionInputFor(contact({ personName: "", companyName: "", companyUrl: "not a url", personDesignation: "" }));
    expect(none.name).toBe("Hiring Team");
    expect(none.company).toBeUndefined();
    expect(none.companyUrl).toBeUndefined(); // an invalid URL is dropped, not fatal
    expect(none.role).toBeUndefined();
    expect(JSON.stringify(none)).not.toContain("your company");
    expect(createConnectionSchema.parse(none).name).toBe("Hiring Team");
  });

  it("targeting is separate from verification: the notes say a default role is not a verified opening", () => {
    const n = connectionInputFor(contact()).notes!;
    expect(n).toContain("Source: Outreach Database HRC-000000000001");
    expect(n).toContain("Role basis: default-fallback (Unverified) - a targeting choice for outreach, not a verified opening.");
    expect(n).toContain("Company description (from the company's website): Acme builds things.");
    expect(n.startsWith("Source: Network Finder")).toBe(false);
  });

  it("import order: best-identified first, company addresses before public ones, deterministic", () => {
    const list = [
      contact({ contactId: "HRC-0000000000D4", personName: "", companyName: "" }),
      contact({ contactId: "HRC-0000000000C3", personName: "", emailKind: "public-provider" }),
      contact({ contactId: "HRC-0000000000B2", emailKind: "public-provider" }),
      contact({ contactId: "HRC-0000000000A1" }),
      contact({ contactId: "HRC-0000000000A0" }),
    ].sort(importOrder);
    expect(list.map((c) => c.contactId)).toEqual(["HRC-0000000000A0", "HRC-0000000000A1", "HRC-0000000000B2", "HRC-0000000000C3", "HRC-0000000000D4"]);
  });

  it("eligibility rules and duplicate-group handling", () => {
    const first = new Set<string>();
    expect(importEligibility(contact(), first).eligible).toBe(true);
    expect(importEligibility(contact({ emailKind: "legacy-isp" }), first).reasons).toContain("legacy ISP address");
    expect(importEligibility(contact({ personDesignation: "Angel Investor" }), first).eligible).toBe(false);
    expect(importEligibility(contact({ primaryRoleCategory: "Unverified" }), first).reasons).toContain("no mappable role category");
    const group = [contact({ contactId: "HRC-000000000002", duplicateGroup: "DG-A" }), contact({ contactId: "HRC-000000000001", duplicateGroup: "DG-A" })];
    const f = firstInDuplicateGroups(group);
    expect([...f]).toEqual(["HRC-000000000001"]);
    expect(importEligibility(group[0], f).eligible).toBe(false);
    expect(importEligibility(group[1], f).eligible).toBe(true);
  });

  it("parseMasterRows needs the required columns and never throws on bad rows", () => {
    expect(() => parseMasterRows([["ContactID", "PersonEmail"], ["x", "y"]])).toThrow(/missing required column/);
    const p = parseMasterRows(masterGrid([masterRow({ PersonEmail: "a@b.example.com" }), masterRow({ PersonEmail: "not-an-email" })]));
    expect(p.contacts).toHaveLength(1);
    expect(p.rejected[0].reason).toMatch(/invalid e-mail/);
  });
});

describe("configuration", () => {
  it("is OFF by default; the daily limit can be lowered but never raised above 200", () => {
    expect(loadOutreachConfig({} as NodeJS.ProcessEnv).enabled).toBe(false);
    expect(loadOutreachConfig({ OUTREACH_ENABLED: "true" } as unknown as NodeJS.ProcessEnv).enabled).toBe(true);
    expect(loadOutreachConfig({} as NodeJS.ProcessEnv).dailyLimit).toBe(DAILY_IMPORT_LIMIT);
    expect(loadOutreachConfig({ OUTREACH_DAILY_LIMIT: "50" } as unknown as NodeJS.ProcessEnv).dailyLimit).toBe(50);
    expect(loadOutreachConfig({ OUTREACH_DAILY_LIMIT: "5000" } as unknown as NodeJS.ProcessEnv).dailyLimit).toBe(200);
    expect(loadOutreachConfig({ OUTREACH_DAILY_LIMIT: "0" } as unknown as NodeJS.ProcessEnv).dailyLimit).toBe(200);
    expect(loadOutreachConfig({ OUTREACH_DAILY_LIMIT: "abc" } as unknown as NodeJS.ProcessEnv).dailyLimit).toBe(200);
  });
});

const rec = (over: Partial<TrackingRecord> = {}): TrackingRecord => ({
  row: 2, contactId: "HRC-000000000001", email: "jane@acme.example.com", source: "outreach-database", importStatus: "added", connectionId: "conn_1", ownerMemberId: "anni", importDay: "2026-11-05",
  claimedAt: "", addedAt: "", attempts: 1, segment: "person-and-company", targetRole: "Software Engineer", roleBasis: "default-fallback", processing: "awaiting", drafts: emptyDrafts(),
  reviewReason: "", ...emptySendFields(), sentAt: "", lastError: "", updatedAt: "", ...over,
});
const ledger = (conn: string, entries: Partial<Record<MemberId, LedgerEntry>>): Map<string, LedgerEntry> => new Map(Object.entries(entries).map(([m, e]) => [draftKeyFor(conn, m as MemberId), e!]));

describe("processing status, counters and history", () => {
  const ok = (file: string): LedgerEntry => ({ status: "created", detail: `attached: ${file}` });

  it("derives awaiting / drafting / drafted / needs_review / failed / sent per contact", () => {
    const all = MEMBER_IDS;
    expect(deriveProcessing("c", ledger("c", {}), all).processing).toBe("awaiting");
    expect(deriveProcessing("c", ledger("c", { anni: ok("a.pdf") }), all).processing).toBe("drafting");
    expect(deriveProcessing("c", ledger("c", { anni: ok("a.pdf"), lukky: ok("l.pdf"), rishii: ok("r.pdf") }), all)).toMatchObject({ processing: "drafted", reviewReason: "" });
    expect(deriveProcessing("c", ledger("c", { anni: { status: "failed", detail: "boom" } }), all).processing).toBe("failed");
    // a member without Gmail does not block "drafted" for the connected ones
    expect(deriveProcessing("c", ledger("c", { anni: ok("a.pdf"), lukky: ok("l.pdf") }), ["anni", "lukky"]).processing).toBe("drafted");
    const review = deriveProcessing("c", ledger("c", { anni: { status: "created", detail: "review: no usable resume (x); no attachment" }, lukky: ok("l.pdf"), rishii: ok("r.pdf") }), all);
    expect(review.processing).toBe("needs_review");
    expect(review.reviewReason).toContain("no usable resume");
    expect(deriveProcessing("c", ledger("c", { anni: { status: "sent", detail: "attached: a" }, lukky: { status: "sent", detail: "" }, rishii: { status: "sent", detail: "" } }), all)).toMatchObject({ processing: "sent", allSent: true });
  });

  it("an informational note is not a review flag", () => {
    const d = deriveProcessing("c", ledger("c", { anni: { status: "created", detail: "note: company name unknown; generic company wording was used; resume: x; attached: a.pdf" }, lukky: ok("l"), rishii: ok("r") }), MEMBER_IDS);
    expect(d.processing).toBe("drafted");
  });

  it("reads the attached resume back from the ledger detail", () => {
    expect(resumeFromDetail("created", "attached: Aniket_Raj_SDE.pdf")).toBe("Aniket_Raj_SDE.pdf");
    expect(resumeFromDetail("created", "resume: Data resume unavailable (x); the member's SDE resume was used; attached: Lakshya_SDE.pdf")).toBe("Lakshya_SDE.pdf");
    expect(resumeFromDetail("created", "review: no usable resume (x); no attachment")).toBe("none");
    expect(resumeFromDetail("failed", "attached: x")).toBe("");
  });

  it("counters count only what really exists (failed or incomplete work is never counted as drafted or sent)", () => {
    const d = deriveProcessing("c1", ledger("c1", { anni: ok("a"), lukky: ok("l"), rishii: ok("r") }), MEMBER_IDS);
    const records = [
      rec({ contactId: "1", connectionId: "c1", processing: d.processing, drafts: d.drafts }),
      rec({ contactId: "2", connectionId: "c2", processing: "failed", drafts: { ...emptyDrafts(), anni: { status: "failed", resume: "" } } }),
      rec({ contactId: "3", connectionId: "c3", processing: "needs_review", drafts: { ...emptyDrafts(), anni: { status: "created", resume: "none" } } }),
      rec({ contactId: "4", connectionId: "", importStatus: "importing" }),
      rec({ contactId: "5", connectionId: "", importStatus: "import_failed" }),
      rec({ contactId: "6", connectionId: "c6", source: "manual", importDay: "", processing: "awaiting" }),
      rec({ contactId: "7", connectionId: "c7", processing: "awaiting", lastError: "linked-existing" }),
    ];
    expect(computeCounters(records, "2026-11-05", 123)).toEqual({
      day: "2026-11-05", importedToday: 3 /* 1,2,3 (the importing/failed/manual/linked ones are not "imported today") */, addedToConnections: 5, emailsDrafted: 4, emailsSent: 0,
      awaitingProcessing: 2, requiringReview: 1, failedProcessing: 1, importFailed: 1, queueRemaining: 123,
      sentToday: 0, sentTodayByMember: { anni: 0, lukky: 0, rishii: 0 }, failedSends: 0, skippedContacts: 0, duplicatesPrevented: 1 /* the linked-existing one */, sendsNeedingReview: 0,
    });
  });
});

describe("send eligibility and duplicate-send protection (mocks only)", () => {
  const facts = (over: Partial<DraftFacts> = {}): DraftFacts => ({ member: "anni", to: "jane@acme.example.com", body: "Dear Jane,\n\nHello.", attachments: ["Aniket_Raj_SDE.pdf"], status: "created", reviewFlags: [], ...over });
  const sentSet = new Set<string>();

  it("the code-level sending switch is a compile-time constant (now open); the outreach cron's own switch stays off by default", () => {
    expect(SENDING_ENABLED).toBe(true);
    expect(loadOutreachConfig({} as NodeJS.ProcessEnv).enabled).toBe(false); // nothing runs unless OUTREACH_ENABLED=true
  });

  it("everything lines up -> eligible", () => {
    expect(evaluateSendEligibility(rec(), facts(), "Aniket_Raj_SDE.pdf", sentSet)).toEqual({ eligible: true, reasons: [] });
  });

  it("each failed validation blocks sending and says why", () => {
    const why = (f: Partial<DraftFacts>, exp = "Aniket_Raj_SDE.pdf", r = rec(), s = sentSet) => evaluateSendEligibility(r, facts(f), exp, s).reasons.join(" | ");
    expect(why({ to: "someone.else@acme.example.com" })).toMatch(/differs from the contact/);
    expect(why({ to: "not-an-address" })).toMatch(/not a valid address/);
    expect(why({ status: "failed" })).toMatch(/no live draft/);
    expect(why({ status: "sent" })).toMatch(/already sent/);
    expect(why({ reviewFlags: ["no usable resume"] })).toMatch(/review flag/);
    expect(why({ body: "Dear Jane,\n\n{{company}}" })).toMatch(/placeholder/);
    expect(why({ body: "Hello there" })).toMatch(/no personalised greeting/);
    expect(why({ attachments: [] })).toMatch(/not exactly the chosen resume/);
    expect(why({ attachments: ["Lakshya_SDE.pdf"] })).toMatch(/not exactly the chosen resume/);
    expect(why({ attachments: ["Aniket_Raj_SDE.pdf", "Other.pdf"] })).toMatch(/not exactly the chosen resume/);
    expect(why({}, "")).toMatch(/no resume could be chosen/);
    expect(why({}, "Aniket_Raj_SDE.pdf", rec({ importStatus: "importing" }))).toMatch(/not added to Connections/);
    expect(why({}, "Aniket_Raj_SDE.pdf", rec({ sendStatus: "sent" }))).toMatch(/already sent to this recipient/);
    expect(why({}, "Aniket_Raj_SDE.pdf", rec(), new Set(["anni:jane@acme.example.com"]))).toMatch(/already sent to this recipient from this mailbox/);
  });

  const mailer = (impl?: Mailer["sendDraft"]) => ({ sendDraft: vi.fn(impl ?? (async () => ({ confirmedMessageId: "msg-1" }))) });

  it("while disabled, attemptSend never touches the mailer, even for an eligible draft", async () => {
    const m = mailer();
    expect(await attemptSend({ eligible: true, reasons: [] }, m, "anni", "d1", false)).toEqual({ status: "disabled" });
    expect(m.sendDraft).not.toHaveBeenCalled();
  });

  it("(guarded path, mock mailer) an eligible draft is sent and counted only on Gmail's confirmation", async () => {
    const m = mailer();
    expect(await attemptSend({ eligible: true, reasons: [] }, m, "anni", "d1", true)).toEqual({ status: "sent", confirmedMessageId: "msg-1" });
    expect(m.sendDraft).toHaveBeenCalledTimes(1);
  });

  it("(guarded path) ineligible -> needs_review and the mailer is not called; failure or no confirmation -> failed, never sent", async () => {
    const m = mailer();
    expect(await attemptSend({ eligible: false, reasons: ["x"] }, m, "anni", "d1", true)).toEqual({ status: "needs_review", reasons: ["x"] });
    expect(m.sendDraft).not.toHaveBeenCalled();
    expect((await attemptSend({ eligible: true, reasons: [] }, mailer(async () => { throw new Error("quota"); }), "anni", "d1", true)).status).toBe("failed");
    expect((await attemptSend({ eligible: true, reasons: [] }, mailer(async () => ({ confirmedMessageId: "" })), "anni", "d1", true)).status).toBe("failed");
  });

  it("(guarded path) a second attempt after a confirmed send is blocked by duplicate-send protection", async () => {
    const sent = new Set<string>(["anni:jane@acme.example.com"]);
    const check = evaluateSendEligibility(rec({ sendStatus: "sent" }), facts({ status: "sent" }), "Aniket_Raj_SDE.pdf", sent);
    const m = mailer();
    expect((await attemptSend(check, m, "anni", "d1", true)).status).toBe("needs_review");
    expect(m.sendDraft).not.toHaveBeenCalled();
  });
});

describe("the outreach cron endpoint", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("401 without the secret, 503 when unconfigured or switched off; never runs when off", async () => {
    const { GET } = await import("@/app/api/cron/outreach/route");
    const call = (auth?: string) => GET(new Request("http://localhost/api/cron/outreach", { headers: auth ? { authorization: auth } : {} }));
    vi.stubEnv("OUTREACH_CRON_SECRET", "");
    expect((await call("Bearer x")).status).toBe(503);
    vi.stubEnv("OUTREACH_CRON_SECRET", "s3cret");
    expect((await call()).status).toBe(401);
    expect((await call("Bearer wrong")).status).toBe(401);
    vi.stubEnv("OUTREACH_ENABLED", "false");
    const off = await call("Bearer s3cret");
    expect(off.status).toBe(503);
    expect((await off.json()).error.code).toBe("disabled");
  });
});
