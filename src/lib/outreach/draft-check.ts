/**
 * Checks the REAL saved Gmail draft (read back) against what it must be, before anything is sent. Pure: no I/O.
 * "Supported information" means: the greeting, company wording, role and signature are the ones the data supports, no placeholder
 * text, nothing about another member, and the body is within the word limit.
 */
import { getMember, MEMBERS, type MemberId } from "@/config/members";
import { isFallbackCompany, FALLBACK_COMPANY } from "@/config/outreach-wording";
import { MAX_WORDS, recipientFirstName, wordCount } from "@/lib/network-finder/email-composer";
import { normalizeEmail } from "@/lib/hr-master/normalize";
import type { DraftReadback } from "@/lib/gmail/send";

export interface ExpectedDraft {
  member: MemberId;
  recipientEmail: string;
  personName: string;
  companyName: string;
  applyRole: string;
}

export interface DraftCheck {
  ok: boolean;
  /** Which of the pre-send validations failed, with the exact reason. */
  failures: { check: "recipient" | "content" | "word_limit"; reason: string }[];
  words: number;
}

const PLACEHOLDER = /\{\{|\}\}|\[(name|company|role)\]|\bundefined\b|\bnull\b|lorem ipsum/i;
const addressOf = (header: string) => /<([^>]+)>/.exec(header)?.[1] ?? header;

/** Words of the message body, excluding the signature (everything from "Best regards," on), as the composer counts them. */
export function bodyWordCount(body: string): number {
  const cut = body.lastIndexOf("Best regards,");
  return wordCount(cut >= 0 ? body.slice(0, cut) : body);
}

export function checkDraft(draft: DraftReadback, expected: ExpectedDraft): DraftCheck {
  const failures: DraftCheck["failures"] = [];
  const fail = (check: DraftCheck["failures"][number]["check"], reason: string) => failures.push({ check, reason });
  const words = bodyWordCount(draft.body);

  const to = normalizeEmail(addressOf(draft.to));
  if (!to.valid || to.email !== normalizeEmail(expected.recipientEmail).email) fail("recipient", "the draft's recipient is not the contact's address");

  if (words > MAX_WORDS) fail("word_limit", `body is ${words} words (limit ${MAX_WORDS})`);
  if (words < 20) fail("content", `body is only ${words} words`);

  const first = recipientFirstName(expected.personName);
  const greeting = first ? `Dear ${first},` : "Dear Hiring Team,";
  if (!draft.body.startsWith(greeting)) fail("content", `greeting should be "${greeting}"`);

  if (PLACEHOLDER.test(draft.body) || PLACEHOLDER.test(draft.subject)) fail("content", "unresolved placeholder text");

  const company = expected.companyName.trim();
  // Company and role must be stated in the BODY the recipient reads (a subject line alone is not enough).
  const text = draft.body.toLowerCase();
  if (company && !isFallbackCompany(company)) {
    if (!text.includes(company.toLowerCase())) fail("content", "the company name is not mentioned");
  } else if (!text.includes(FALLBACK_COMPANY)) fail("content", `"${FALLBACK_COMPANY}" wording is missing for an unknown company`);

  // The role must be stated as the phrase itself ("Software Engineer"), not merely as scattered words ("software ... engineering").
  const phrase = expected.applyRole.toLowerCase().replace(/\s+/g, " ").trim();
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (phrase && !new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(text.replace(/\s+/g, " "))) fail("content", `the target role "${expected.applyRole}" is not stated`);

  const me = getMember(expected.member);
  if (!me) fail("content", "unknown member");
  else {
    if (!draft.body.includes(me.fullName)) fail("content", "the signature does not carry the member's name");
    for (const other of MEMBERS) {
      if (other.id === expected.member) continue;
      if (draft.body.includes(other.fullName) || draft.body.includes(other.githubUrl) || draft.body.includes(other.linkedinUrl)) fail("content", `the draft mentions another member (${other.id})`);
    }
  }
  return { ok: failures.length === 0, failures, words };
}

/** Checks the attachment: exactly one file, the expected name, the expected size. */
export function checkAttachment(draft: DraftReadback, expected: { fileName: string; bytes: number } | null): string | null {
  if (!expected) return draft.attachments.length === 0 ? null : "the draft has an attachment although no resume could be chosen";
  if (draft.attachments.length !== 1) return `expected exactly one attachment, found ${draft.attachments.length}`;
  const a = draft.attachments[0];
  if (a.filename !== expected.fileName) return `attached file is "${a.filename}", expected "${expected.fileName}"`;
  if (a.size !== expected.bytes) return `attached file is ${a.size} bytes, the member's resume is ${expected.bytes} bytes`;
  return null;
}
