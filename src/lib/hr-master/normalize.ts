import type { ContactKind, EmailKind } from "./types.ts";

const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

export interface NormalizedEmail {
  email: string;
  valid: boolean;
  reason?: string;
  /** True when stray whitespace around "." or "@" (a data-entry artefact such as "name@corp. com") was removed. */
  repaired?: boolean;
}

/** Lower-cases, strips mailto:, wrapping punctuation and trailing dots; validates shape (not deliverability). */
export function normalizeEmail(raw: string): NormalizedEmail {
  let e = (raw ?? "").normalize("NFKC").trim().toLowerCase();
  e = e.replace(/^mailto:/, "").replace(/^[<("'\s]+|[>)"',;:\s]+$/g, "").replace(/\.+$/, "");
  if (!e) return { email: "", valid: false, reason: "empty" };
  let repaired = false;
  if (/\s/.test(e)) {
    const fixed = e.replace(/\s*([.@])\s*/g, "$1");
    if (/\s/.test(fixed)) return { email: e, valid: false, reason: "contains whitespace" };
    e = fixed;
    repaired = true;
  }
  if ((e.match(/@/g) ?? []).length !== 1) return { email: e, valid: false, reason: "must contain exactly one @" };
  if (e.length > 254) return { email: e, valid: false, reason: "too long" };
  const [local, domain] = e.split("@");
  if (!local || local.length > 64) return { email: e, valid: false, reason: "invalid local part" };
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return { email: e, valid: false, reason: "invalid local part" };
  if (!EMAIL_RE.test(e)) return { email: e, valid: false, reason: "malformed address" };
  const tld = domain.split(".").pop() ?? "";
  if (!/^[a-z]{2,24}$/.test(tld)) return { email: e, valid: false, reason: "invalid top-level domain" };
  return repaired ? { email: e, valid: true, repaired } : { email: e, valid: true };
}

export function emailDomain(email: string): string {
  const i = email.lastIndexOf("@");
  return i < 0 ? "" : normalizeDomain(email.slice(i + 1));
}

/** "https://www.Example.com:443/path?q" -> "example.com". Returns "" when nothing domain-like remains. */
export function normalizeDomain(raw: string): string {
  let d = (raw ?? "").trim().toLowerCase();
  if (!d) return "";
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^[^@/]*@/, "");
  d = d.split(/[/?#\s]/)[0].replace(/:\d+$/, "").replace(/\.+$/, "").replace(/^www\d?\./, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) ? d : "";
}

const PUBLIC_PROVIDER_RE = [
  /^(gmail|googlemail)\.com$/,
  /^yahoo\.[a-z.]+$/,
  /^ymail\.com$/,
  /^rocketmail\.com$/,
  /^(hotmail|outlook|live|msn)\.[a-z.]+$/,
  /^rediff(mail)?\.com$/,
  /^aol\.com$/,
  /^(icloud|me|mac)\.com$/,
  /^(proton\.me|protonmail\.com|pm\.me)$/,
  /^(gmx|mail|email|inbox|fastmail|yandex|zohomail)\.[a-z.]+$/,
  /^(sify|indiatimes|in|lycos|hushmail|tutanota)\.com$/,
];
/** Pre-2005 Indian ISP / portal mailboxes in the PDF: shared by many unrelated customers, never a company site. */
const LEGACY_ISP_RE = [
  /(^|\.)vsnl\.(net|com)(\.in)?$/,
  /^usa\.net$/,
  /^(eth|dataone|sancharnet|bol|touchtelindia)\.(net|in)$/,
  /^123india\.com$/,
  /^satyam(online)?\.(net|com)(\.in)?$/,
];

export function emailKindOf(domain: string): EmailKind {
  if (LEGACY_ISP_RE.some((r) => r.test(domain))) return "legacy-isp";
  if (PUBLIC_PROVIDER_RE.some((r) => r.test(domain))) return "public-provider";
  return "company";
}

const PLACEHOLDER_NAMES = new Set([
  "hr", "h r", "hrd", "hr team", "hr department", "hiring team", "hiring", "hiring manager", "hr manager", "recruitment", "recruiter", "recruitment team",
  "talent acquisition", "talent", "careers", "career", "jobs", "info", "contact", "general", "admin", "team", "support", "sales", "hello", "resume", "resumes",
  "human resources", "hr head", "hr executive", "hr & admin", "n/a", "na", "none", "unknown",
]);

/** Cleans a person name: strips encoding junk, honorifics and trailing separators; collapses whitespace. */
export function cleanName(raw: string): string {
  return (raw ?? "")
    .normalize("NFKC")
    .replace(/[�\u0000-\u001F]/g, " ")
    .replace(/^(mr|mrs|ms|miss|dr|prof|shri|smt)\.?\s+/i, "")
    .replace(/[|;,]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function isPlaceholderName(name: string): boolean {
  const n = cleanName(name).toLowerCase().replace(/[^a-z& /]/g, "").trim();
  if (!n || PLACEHOLDER_NAMES.has(n)) return true;
  return /^(hr|hiring|recruit\w*|careers?|jobs?)\b/.test(n) && n.split(" ").length <= 2;
}

/** Comparison key for "same person?" checks: lower-case letters only, tokens sorted so "Rao Anil" equals "Anil Rao". */
export function nameKey(name: string): string {
  return cleanName(name)
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .sort()
    .join(" ");
}

export function cleanCompany(raw: string): string {
  return (raw ?? "")
    .normalize("NFKC")
    .replace(/[�\u0000-\u001F]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[\s,;.:\-]+$/g, "")
    .trim()
    .replace(/^=.*$/, ""); // spreadsheet formula residue such as "=A2318" is not a company name
}

const COMPANY_NOISE =
  /\b(pvt|private|ltd|limited|llp|llc|inc|incorporated|corp|corporation|co|company|india|technologies|technology|tech|solutions|services|systems|software|group|the)\b/g;
/** Comparison key for company names: strips legal suffixes and generic words. */
export function companyKey(name: string): string {
  return cleanName(name).toLowerCase().replace(/&/g, " and ").replace(COMPANY_NOISE, " ").replace(/[^a-z0-9]/g, "");
}

/** True when the stated company name and the email domain clearly refer to different organisations. */
export function companyDomainMismatch(company: string, domain: string): boolean {
  const ck = companyKey(company);
  const label = (domain.split(".")[0] ?? "").replace(/[^a-z0-9]/g, "");
  if (!ck || !label) return false;
  if (ck.includes(label) || label.includes(ck)) return false;
  const initials = company
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join("");
  return !(initials.length >= 2 && (label.startsWith(initials) || initials.startsWith(label)));
}

const ROLE_LOCALS = new Set([
  "info", "careers", "career", "jobs", "job", "hr", "hrd", "hrdindia", "recruit", "recruitment", "recruiting", "resume", "resumes", "cv", "admin", "contact",
  "contactus", "hello", "hi", "support", "sales", "enquiry", "inquiry", "enquiries", "talent", "talentacquisition", "hiring", "apply", "work", "joinus", "join",
  "team", "office", "mail", "humanresources", "peopleteam", "people", "employment", "accessibility", "careerindia", "hrindia", "recruiter", "freshers",
]);

export function contactKindOf(email: string, name: string): ContactKind {
  const local = email.split("@")[0] ?? "";
  const bare = local.replace(/[^a-z]/g, "");
  if (ROLE_LOCALS.has(bare)) return "role-mailbox";
  if (/^(hr|careers?|jobs?|recruit\w*|resumes?|hiring)[-_.]?[a-z]{0,12}$/.test(local) && isPlaceholderName(name)) return "role-mailbox";
  return isPlaceholderName(name) ? "unknown" : "person";
}

/** Rough check that a mailbox local part plausibly belongs to the named person (john.doe, jdoe, john_d, doe.john ...). */
export function localPartMatchesName(email: string, name: string): boolean {
  const local = (email.split("@")[0] ?? "").toLowerCase().replace(/[^a-z]/g, " ");
  const compact = local.replace(/\s/g, "");
  const tokens = cleanName(name)
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return false;
  if (tokens.some((t) => t.length >= 3 && compact.includes(t))) return true;
  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  return tokens.length >= 2 && (compact === first[0] + last || compact === last[0] + first || compact === first + last[0] || compact === last + first[0]);
}

/** Registrable-ish domain: last two labels (three for common second-level ccTLDs such as co.in). */
export function registrableDomain(host: string): string {
  const h = normalizeDomain(host);
  const parts = h.split(".");
  if (parts.length <= 2) return h;
  const sld = parts[parts.length - 2];
  const useThree = parts[parts.length - 1].length === 2 && ["co", "com", "org", "net", "ac", "gov", "edu", "in", "nic"].includes(sld);
  return parts.slice(useThree ? -3 : -2).join(".");
}
