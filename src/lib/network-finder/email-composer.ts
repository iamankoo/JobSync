import { DEFAULT_TEMPLATE, EMAIL_TEMPLATES, TEMPLATES_BY_ID, type EmailTemplate } from "@/config/email-templates";
import { MEMBER_EMAIL_PROFILES, type Highlight, type MemberEmailProfile } from "@/config/member-email-profiles";
import { MEMBERS, getMember, type Member, type MemberId } from "@/config/members";
import { SKILLS, TECH_CATEGORIES, getSkill, type Skill, type TemplateId } from "@/config/skills";
import type { Job } from "@/types/domain";
import { matchRole } from "./roles";

/**
 * Network Finder email composer: job data → role classification → skill matching (approved taxonomy ∩ the member's
 * verified profile) → template → company/contact personalisation → member identity + links. Produces the PLAN that
 * Nemotron writes within, a deterministic fallback email, and the validation every draft must pass before it is
 * saved. Pure (no I/O), so every rule is unit-tested.
 */

// ---- inputs ----------------------------------------------------------------------------------------------------

export interface EmailJob {
  title: string;
  /** What the role works on, e.g. "Video Generation" (from the connection's description). */
  focus?: string;
  description?: string;
  internship?: boolean;
  location?: string;
  workMode?: string;
}

export interface EmailInput {
  memberId: MemberId;
  company: { name: string; website?: string; description?: string; /** Verbatim sentences from the company's own pages (see company-research.ts). */ facts?: readonly string[] };
  person?: { name: string; title?: string };
  recipientEmail?: string;
  job?: EmailJob;
  /**
   * True when no role could be established (missing / ambiguous description): the plan is a neutral enquiry that
   * assumes no role, no template emphasis and no skills — never a default "Software Engineer".
   */
  neutral?: boolean;
}

export interface EmailPlan {
  memberId: MemberId;
  member: Pick<Member, "fullName" | "linkedinUrl" | "githubUrl">;
  templateId: TemplateId;
  templateVersion: number;
  company: string;
  companyContext?: string;
  /** Further verbatim sentences from the company's own pages, each from a source the research recorded. */
  companyFacts?: string[];
  /** The exact job title when known; otherwise null (the email then speaks of the role family). */
  jobTitle: string | null;
  /** What the role works on (after the title), when the description names it. */
  roleFocus: string | null;
  /** A neutral enquiry about opportunities: the role is unknown, so nothing role-specific is claimed. */
  neutral: boolean;
  roleLabel: string;
  internship: boolean;
  jobDescriptionExcerpt?: string;
  recipientFirstName: string | null;
  greeting: string;
  subject: string;
  education: string;
  location: string;
  /** 2–4 short areas the member can genuinely claim for this role. */
  areas: string[];
  /** 0–8 skill names (approved ∩ member's) most relevant to this role and job. */
  skills: string[];
  /** Skills that also appear in the job title/description (for a natural "the role's focus on …" sentence). */
  skillsInJob: string[];
  highlights: Highlight[];
  capabilities: string[];
  /** Role value sentence, only when the member's facts support it. */
  valueProposition: string | null;
  motivation: string;
  contributeTo: string;
  mentionRemote: boolean;
  guidance: string;
  /** Minimum words for this member: lower when the member has no verified highlights yet (no padding). */
  minWords: number;
}

// Short, personal emails: about 100-140 words (a little slack on the hard limit).
export const MAX_WORDS = 150;
export const MIN_WORDS = 100;
export const MIN_WORDS_ONE_HIGHLIGHT = 85;
export const MIN_WORDS_THIN_PROFILE = 50;
export const MIN_WORDS_NEUTRAL = 60;
export const MAX_SKILLS = 8;

// ---- text helpers ------------------------------------------------------------------------------------------------

const norm = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9.+#/\s-]/g, " ").replace(/\s+/g, " ").trim()} `;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Whole-phrase, case-insensitive match (letters/digits around the phrase are not part of it). */
export const mentions = (text: string, phrase: string) => new RegExp(`(^|[^a-z0-9])${escapeRe(phrase.toLowerCase())}([^a-z0-9+]|$)`).test(text.toLowerCase());
const listJoin = (items: string[]) =>
  items.length <= 1 ? items.join("") : items.length === 2 ? `${items[0]} and ${items[1]}` : `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
export const wordCount = (s: string) => (s.match(/[A-Za-z0-9][A-Za-z0-9'’.+#/-]*/g) ?? []).length;

// ---- role classification ----------------------------------------------------------------------------------------

/**
 * Picks the template for a job. Title keywords decide; the most specific (longest) match wins and the generic
 * "software" template only applies when nothing more specific matches. Without a title match, the description
 * decides if it clearly points one way (≥ 2 keyword hits); otherwise the default (Software Engineer).
 */
export function selectTemplate(title?: string, description?: string): TemplateId {
  return matchTemplate(title, description) ?? DEFAULT_TEMPLATE;
}

/** The template the title (or a clear description) points to, or null when nothing does (no default applied). */
export function matchTemplate(title?: string, description?: string): TemplateId | null {
  const t = norm(title ?? "");
  const scored = EMAIL_TEMPLATES.map((tpl) => ({ tpl, best: Math.max(0, ...tpl.keywords.filter((k) => mentions(t, k)).map((k) => k.length)) })).filter((x) => x.best > 0);
  const specific = scored.filter((x) => x.tpl.id !== "software");
  const pool = specific.length ? specific : scored;
  if (pool.length) return pool.sort((a, b) => b.best - a.best)[0].tpl.id;
  const d = norm(description ?? "");
  if (d.trim()) {
    const hits = EMAIL_TEMPLATES.filter((tpl) => tpl.id !== "software").map((tpl) => ({ id: tpl.id, n: tpl.keywords.filter((k) => mentions(d, k)).length })).sort((a, b) => b.n - a.n);
    if (hits[0]?.n >= 2 && hits[0].n > (hits[1]?.n ?? 0)) return hits[0].id;
  }
  return null;
}

const companyKey = (s: string) => s.toLowerCase().replace(/\b(inc|llc|ltd|limited|pvt|private|corp|corporation|co|gmbh|technologies|technology|labs?)\b/g, "").replace(/[^a-z0-9]/g, "");

/** The company's open jobs in Jobs (early-career relevant first, newest first). */
export function jobsForCompany(jobs: readonly Job[], companyName: string): EmailJob[] {
  const key = companyKey(companyName);
  if (!key) return [];
  return jobs
    .filter((j) => companyKey(j.company) === key)
    .sort((a, b) => Number(matchRole(b.jobRole).relevant) - Number(matchRole(a.jobRole).relevant) || b.addedAt.localeCompare(a.addedAt))
    .map((j) => ({ title: j.jobRole, ...(j.description ? { description: j.description } : {}), internship: j.jobType === "Internship", location: j.location, ...(j.workMode ? { workMode: j.workMode } : {}) }));
}

/** The company's best open job in Jobs (relevant for early-career roles, newest first), or undefined. */
export function jobForCompany(jobs: readonly Job[], companyName: string): EmailJob | undefined {
  return jobsForCompany(jobs, companyName)[0];
}

export const isInternship = (job?: EmailJob) => Boolean(job && (job.internship || /\bintern(ship)?\b/i.test(job.title)));

// ---- skill matching ---------------------------------------------------------------------------------------------

const skillMentioned = (text: string, k: Skill) => [k.name, ...k.aliases].some((p) => mentions(text, p));

/** Skill names that are also everyday words — not scanned as claims. */
const NOT_SCANNED = new Set(["c", "render", "git", "github"]);

/** Technologies named in `text` that the member has NOT verified (after removing `ignore` phrases such as the job title). */
export function unverifiedSkills(text: string, memberId: MemberId, ignore: readonly string[] = []): string[] {
  let scan = text;
  for (const part of ignore) if (part) scan = scan.split(part).join(" ");
  const own = new Set(MEMBER_EMAIL_PROFILES[memberId].skills);
  // Remove the member's OWN skill names first, so "LLM Integration" is not also read as "LLM" (another skill).
  const ownPhrases = SKILLS.filter((k) => own.has(k.id)).flatMap((k) => [k.name, ...k.aliases]).sort((a, b) => b.length - a.length);
  for (const phrase of ownPhrases) scan = scan.replace(new RegExp(`(^|[^a-z0-9])${escapeRe(phrase)}(?=[^a-z0-9+]|$)`, "gi"), "$1 ");
  return SKILLS.filter((k) => TECH_CATEGORIES.includes(k.category) && !own.has(k.id) && !NOT_SCANNED.has(k.id) && skillMentioned(scan, k)).map((k) => k.name);
}

/** 4–8 skills (only the member's own) most relevant to this template and job. */
export function matchSkills(templateId: TemplateId, profile: MemberEmailProfile, jobText: string): { skills: Skill[]; inJob: Skill[] } {
  const tpl = TEMPLATES_BY_ID.get(templateId)!;
  const own = profile.skills.map(getSkill).filter((k): k is Skill => Boolean(k) && TECH_CATEGORIES.includes(k!.category));
  const scored = own
    .map((k) => {
      const rank = tpl.prioritySkills.indexOf(k.id);
      const inJob = jobText ? skillMentioned(jobText, k) : false;
      const score = (rank >= 0 ? 40 - rank * 2 : 0) + (inJob ? 30 : 0) + (k.roles.includes(templateId) ? 10 : 0) + (4 - k.priority);
      return { k, score, inJob };
    })
    .filter((x) => x.score >= 12) // relevant to this role or to this job, not just "something the member knows"
    .sort((a, b) => b.score - a.score);
  const skills = scored.slice(0, MAX_SKILLS).map((x) => x.k);
  return { skills, inJob: scored.filter((x) => x.inJob).slice(0, 3).map((x) => x.k) };
}

/** 1–2 highlights whose skills overlap the selected skills / the role's priorities. */
export function pickHighlights(profile: MemberEmailProfile, selected: Skill[], templateId: TemplateId): Highlight[] {
  const tpl = TEMPLATES_BY_ID.get(templateId)!;
  const sel = new Set(selected.map((k) => k.id));
  return profile.highlights
    .map((h) => ({ h, score: h.skills.filter((s) => sel.has(s)).length * 2 + h.skills.filter((s) => tpl.prioritySkills.includes(s)).length }))
    .filter((x) => x.score >= 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map((x) => x.h);
}

// ---- personalisation -----------------------------------------------------------------------------------------------

const NOT_A_PERSON = /^(hiring|talent|recruit\w*|careers?|jobs?|hr|team|info|contact|hello|support|admin|people|the)$/i;

/** "Dear Rahul," when a real first name is known; otherwise "Dear Hiring Team,". */
export function recipientFirstName(name?: string): string | null {
  const first = (name ?? "").trim().split(/\s+/)[0]?.replace(/[^A-Za-zÀ-ÿ'-]/g, "") ?? "";
  if (first.length < 2 || NOT_A_PERSON.test(first) || /^[A-Z]{2,}$/.test(first)) return null;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

const cleanTitle = (s: string) => s.replace(/\s+/g, " ").replace(/\s*[-–—|(].*$/, "").trim() || s.trim();

export function subjectFor(plan: Pick<EmailPlan, "jobTitle" | "roleLabel" | "internship" | "company"> & { neutral?: boolean }): string {
  if (plan.neutral) return `Enquiry about opportunities at ${plan.company}`;
  if (plan.jobTitle) {
    let role = cleanTitle(plan.jobTitle);
    if (plan.internship) role = /\bintern\b$/i.test(role) ? role.replace(/\bintern$/i, "Internship") : /\binternship\b/i.test(role) ? role : `${role} Internship`;
    return `Application for ${role} — ${plan.company}`;
  }
  return `Application for ${plan.roleLabel} opportunities — ${plan.company}`;
}

/** The first sentence of verified company text (from discovery), short enough to use. */
function companyContextOf(description?: string): string | undefined {
  const first = (description ?? "").replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s/)[0] ?? "";
  return first.length >= 20 && first.length <= 220 ? first : undefined;
}

export function buildEmailPlan(input: EmailInput): EmailPlan {
  const m = getMember(input.memberId)!;
  const profile = MEMBER_EMAIL_PROFILES[input.memberId];
  const neutral = Boolean(input.neutral) && !input.job;
  const templateId = selectTemplate(input.job?.title, `${input.job?.focus ?? ""} ${input.job?.description ?? ""}`);
  const tpl: EmailTemplate = TEMPLATES_BY_ID.get(templateId)!;
  const jobText = `${input.job?.title ?? ""} ${input.job?.focus ?? ""} ${input.job?.description ?? ""}`;
  // A neutral enquiry claims no skills and names no role: the template only supplies safe default wording.
  const { skills, inJob } = neutral ? { skills: [], inJob: [] } : matchSkills(templateId, profile, jobText);
  const highlights = neutral ? [] : pickHighlights(profile, skills, templateId);
  const own = new Set(profile.skills);
  // Template sentences are only used when they claim nothing the member has not verified.
  const honest = (text: string) => unverifiedSkills(text, input.memberId).length === 0;
  const areas = neutral ? [] : tpl.areas.filter((a) => a.skills.some((s) => own.has(s)) && honest(a.text)).slice(0, 3).map((a) => a.text);
  const supported = !neutral && tpl.prioritySkills.filter((s) => own.has(s)).length >= 2 && honest(tpl.valueProposition);
  const firstName = recipientFirstName(input.person?.name);
  const internship = isInternship(input.job);
  const base = { jobTitle: input.job?.title?.trim() || null, roleLabel: neutral ? "engineering" : tpl.roleLabel, internship, company: input.company.name.trim(), neutral };
  const remote = /remote/i.test(`${input.job?.workMode ?? ""} ${input.job?.location ?? ""}`);
  return {
    memberId: input.memberId,
    member: { fullName: m.fullName, linkedinUrl: m.linkedinUrl, githubUrl: m.githubUrl },
    templateId,
    templateVersion: tpl.version,
    ...base,
    roleFocus: input.job?.focus?.trim() || null,
    companyContext: companyContextOf(input.company.description) ?? input.company.facts?.map(companyContextOf).find(Boolean),
    ...(input.company.facts?.length ? { companyFacts: input.company.facts.slice(0, 3) } : {}),
    jobDescriptionExcerpt: input.job?.description ? input.job.description.replace(/\s+/g, " ").trim().slice(0, 900) : undefined,
    recipientFirstName: firstName,
    greeting: `Dear ${firstName ?? "Hiring Team"},`,
    subject: subjectFor(base),
    education: profile.education,
    location: profile.location,
    areas,
    skills: skills.map((k) => k.name),
    skillsInJob: inJob.map((k) => k.name),
    highlights,
    capabilities: highlights.length && tpl.capabilities.every(honest) ? [...tpl.capabilities] : [],
    valueProposition: supported ? tpl.valueProposition : null,
    motivation: !neutral && honest(tpl.neutralMotivation) ? tpl.neutralMotivation : "the work your team is doing",
    contributeTo: !neutral && honest(tpl.contributeTo) ? tpl.contributeTo : "your engineering team",
    mentionRemote: remote && Boolean(profile.location),
    guidance: neutral ? "Neutral enquiry: the role is not known, so ask which roles are open. Claim no skills." : tpl.guidance,
    // Fewer verified facts → shorter (but complete) emails, never padding.
    minWords: neutral ? MIN_WORDS_NEUTRAL : profile.highlights.length >= 2 ? MIN_WORDS : profile.highlights.length === 1 ? MIN_WORDS_ONE_HIGHLIGHT : MIN_WORDS_THIN_PROFILE,
  };
}

// ---- deterministic fallback (no AI) --------------------------------------------------------------------------------

const article = (title: string) => (/^(?:[aeiou]|ai\b|ml\b|sql\b|sre\b|hr\b)/i.test(title) ? "an" : "a");

/** One highlight as a first-person sentence ("As a Web Developer Intern at X, I built …"). */
function highlightSentence(h: Highlight, index: number): string {
  if (h.kind === "experience") return index === 0 ? `As ${article(h.title)} ${h.title}, I ${h.didWhat}.` : `As ${article(h.title)} ${h.title}, I also ${h.didWhat}.`;
  return index === 0 ? `I have worked on ${h.title}, where I ${h.didWhat}.` : `I also worked on ${h.title}, where I ${h.didWhat}.`;
}

/** The second highlight in one short sentence (used when the full version would not fit the length). */
function shortHighlightSentence(h: Highlight): string {
  return h.kind === "experience" ? `I also worked as ${article(h.title)} ${h.title}.` : `I also built ${h.title}.`;
}

/** One sentence tying the member to the company's VERIFIED work (a single detail, not a research summary). */
function companySentence(p: EmailPlan): string {
  const ctx = p.companyContext?.replace(/["“”]/g, "").replace(/[.!?]+$/, "").trim();
  if (!ctx) return `I'm particularly interested in ${p.motivation}.`;
  const m = new RegExp(`^${escapeRe(p.company)}\\s+(is|are|provides|builds|offers|helps|develops|creates|makes|delivers)\\s+(.+)$`, "i").exec(ctx);
  if (m) {
    const verb = m[1].toLowerCase();
    return verb === "is" || verb === "are" ? `I'm particularly interested in ${p.company}'s work as ${m[2]}.` : `I'm particularly interested in ${p.company}'s work, since it ${verb} ${m[2]}.`;
  }
  return `What draws me to ${p.company} is its work: ${ctx}.`;
}

/** Target length of the whole body (without greeting and signature), closing included. */
export const TARGET_MAX_WORDS = 140;

/**
 * A complete, honest, SHORT email body (paragraphs only, no greeting/sign-off) from the plan's verified facts:
 * a brief hello, who the member is and the role, 1–2 relevant highlights, one company-specific sentence, a polite
 * request, and the fixed closing. No technology lists, no repeated research. Optional parts are dropped, richest
 * first, until the body fits TARGET_MAX_WORDS.
 */
export function composeFallback(p: EmailPlan): string[] {
  if (p.neutral) return composeNeutral(p);
  const focus = p.roleFocus ? `, with a focus on ${p.roleFocus},` : "";
  const role = p.jobTitle ? cleanTitle(p.jobTitle) : "";
  const target = role
    ? /\bintern(ship)?\b/i.test(role)
      ? `the ${role}${focus}`
      : `the ${role}${focus} ${p.internship ? "internship" : "opportunity"}`
    : `${p.roleLabel} opportunities`;
  const intro = `I'm ${p.member.fullName}${p.education ? `, a ${p.education}` : ""}, and I'm interested in ${target} at ${p.company}.`;
  const fit = p.skillsInJob.length >= 2 ? `The role's focus on ${listJoin(p.skillsInJob.slice(0, 2))} matches the work I have been doing.` : "";
  const asks = [
    `I'd appreciate the chance to discuss how my background could contribute to ${p.contributeTo}, and would be grateful for your consideration or a referral.`,
    "I would be grateful for your consideration or a referral.",
  ];
  const company = companySentence(p);
  const total = (paras: string[]) => wordCount(paras.join(" ")) + wordCount(CLOSING);
  let best: string[] = [];
  const [h1, h2] = p.highlights;
  const works: string[][] = [];
  if (h1 && h2) works.push([highlightSentence(h1, 0), highlightSentence(h2, 1)], [highlightSentence(h1, 0), shortHighlightSentence(h2)]);
  if (h1) works.push([highlightSentence(h1, 0)]);
  works.push([]);
  for (const work of works) {
    for (const withFit of fit ? [true, false] : [false]) {
      for (const ask of asks) {
        const paras = ["I hope you're doing well.", intro];
        if (work.length) paras.push(work.join(" "));
        paras.push([withFit ? fit : "", company].filter(Boolean).join(" "), ask);
        best = paras; // ends as the shortest version, used only if nothing fits
        if (total(paras) <= TARGET_MAX_WORDS) return [...paras, CLOSING];
      }
    }
  }
  return [...best, CLOSING];
}

/** An honest enquiry when the role is unknown: no role, skills or projects are claimed. */
function composeNeutral(p: EmailPlan): string[] {
  const paras: string[] = [`I am writing to ask about engineering opportunities at ${p.company}.${p.education ? ` I am a ${p.education}.` : ""}`];
  paras.push(
    p.companyContext
      ? `What draws me to ${p.company} is its work. Your website describes it this way: "${p.companyContext.replace(/["“”]/g, "").replace(/[.!?]+$/, "")}."`
      : `I would like to learn more about what ${p.company} is building and where a new engineer could contribute.`,
  );
  paras.push(`Could you let me know which roles or internships are currently open? I have attached my resume for your reference and would be glad to send a focused application for the one that fits.`);
  paras.push("Thank you for your time and consideration.");
  return paras;
}

const CLOSING = "I have attached my resume for your reference. Thank you for your time and consideration.";

// ---- assembly ------------------------------------------------------------------------------------------------------

export const signatureFor = (p: Pick<EmailPlan, "member">) => `Best regards,\n${p.member.fullName}\nLinkedIn: ${p.member.linkedinUrl}\nGitHub: ${p.member.githubUrl}`;

/** Drops a greeting the writer added and any sign-off/thanks block at the end (we add our own, exactly once). */
export function cleanParagraphs(paragraphs: string[], fullName: string): string[] {
  const out = paragraphs.map((x) => x.trim()).filter(Boolean);
  if (out[0] && /^(dear|hi|hello)\b/i.test(out[0]) && out[0].length < 60) out.shift();
  const signoff = new RegExp(`^(best( regards)?|kind regards|warm regards|regards|sincerely|thanks|thank you|cheers)[,!.]?$|^${escapeRe(fullName)}$|^(linkedin|github)\\s*:`, "i");
  while (out.length && out[out.length - 1].split("\n").every((line) => signoff.test(line.trim()) || !line.trim())) out.pop();
  // A sign-off glued to the last paragraph ("…consideration.\nBest regards,\nName").
  if (out.length) out[out.length - 1] = out[out.length - 1].split("\n").filter((line) => !signoff.test(line.trim())).join("\n").trim();
  return out.filter(Boolean);
}

export function assembleEmail(p: EmailPlan, paragraphs: string[]): string {
  const paras = [...paragraphs];
  // The closing is fixed, whoever wrote the body: drop any resume offer / thanks the writer put in the last paragraph, then add ours.
  const last = paras.pop() ?? "";
  const kept = (last.match(/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g) ?? []).map((x) => x.trim()).filter((x) => x && !/resume|\bCV\b|thank you|thanks/i.test(x)).join(" ");
  if (kept) paras.push(kept);
  paras.push(paras.some((x) => /attached my resume/i.test(x)) ? "Thank you for your time and consideration." : CLOSING);
  return `${p.greeting}\n\n${paras.join("\n\n")}\n\n${signatureFor(p)}`;
}

// ---- validation ------------------------------------------------------------------------------------------------------

const BANNED = [
  "perfect fit", "ideal candidate", "thrilled to apply", "exciting opportunity", "innovative company", "cutting-edge", "leverage", "leveraging",
  "passionate about leveraging", "i am confident my skills", "synergy", "rockstar", "ninja", "world-class",
];
/** Claims of knowing the company that nothing in the data supports. */
const INVENTED_FAMILIARITY = /\b(congratulations|congrats|i (have been|am|was) (following|a (long-?time )?(user|customer|fan))|i (use|used|tried|tested) your (product|app|platform|tool)|your (recent|latest|new) (launch|release|funding|announcement|product|blog post|article)|i (saw|read|noticed|came across) your (recent|latest|new))\b/i;

/** Role names the email states ("…the Frontend Engineer position / role / internship"). */
export function namedRoles(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(/\b(?:the|a|an)\s+((?:[A-Z][A-Za-z0-9+#./&-]*)(?:\s+(?:[A-Z][A-Za-z0-9+#./&-]*|and|of|&|\/)){0,5})\s+(?:position|role|internship|opening|vacancy|opportunity)\b/g)) out.push(m[1].trim());
  return out;
}
const roleKey = (s: string) => s.toLowerCase().replace(/\bintern(ship)?\b/g, "").replace(/[^a-z0-9]/g, "");
const sameRole = (named: string, role: string) => {
  const a = roleKey(named);
  const b = roleKey(role);
  return !a || !b || a === b || a.includes(b) || b.includes(a);
};

/** True when `a` and `b` share at least `n` content words (4+ letters). */
function sharesWords(a: string, b: string, n: number, exclude: string): boolean {
  const skip = new Set(exclude.toLowerCase().match(/[a-z]{4,}/g) ?? []);
  const words = (s: string) => new Set((s.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !STOP.has(w) && !skip.has(w)));
  const wb = words(b);
  let hits = 0;
  for (const w of words(a)) if (wb.has(w) && ++hits >= n) return true;
  return wb.size < n;
}
const STOP = new Set(["with", "that", "this", "your", "from", "have", "their", "they", "into", "what", "will", "them", "been", "more", "also", "such", "than", "help", "make", "build", "team", "work", "company", "platform", "product", "products"]);

const UNVERIFIABLE_COMPANY = /\b(founded in|funding|raised|series [a-e]\b|valuation|unicorn|award-winning|awarded|\d+\s*(million|billion)|\$\s?\d)/i;

/** Every problem that must stop a draft from being saved as written (empty = OK). */
export function validateEmail(body: string, p: EmailPlan): string[] {
  const problems: string[] = [];
  const sig = signatureFor(p);
  if (!body.endsWith(sig)) problems.push("signature missing or not last");
  const content = body.endsWith(sig) ? body.slice(0, -sig.length) : body;
  const paragraphsText = content.replace(p.greeting, "");
  const words = wordCount(paragraphsText);
  if (words > MAX_WORDS) problems.push(`too long (${words} words)`);
  if (words < p.minWords) problems.push(`too short (${words} words)`);
  if (/\{\{|\}\}|\[[A-Z][A-Za-z ]+\]/.test(body)) problems.push("unresolved placeholder");
  if (/…|\.\.\./.test(content)) problems.push("ellipsis / truncation");
  // No unfinished sentences: every paragraph ends with sentence punctuation.
  for (const para of paragraphsText.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean)) if (!/[.!?]["”)]?$/.test(para)) problems.push("paragraph does not end cleanly");
  if (!/[.!?]["”)]?\s*$/.test(content.trim())) problems.push("does not end cleanly");
  if (!content.startsWith(p.greeting)) problems.push("greeting missing");
  if (!mentions(content, p.company)) problems.push("company not mentioned");
  for (const other of MEMBERS.filter((o) => o.id !== p.memberId)) {
    for (const v of [other.fullName, other.linkedinUrl, other.githubUrl]) if (body.includes(v)) problems.push(`another member's identity (${other.id})`);
  }
  if (/\b(anni|lukky|rishii)\b/i.test(content)) problems.push("internal member id in text");
  const lower = content.toLowerCase();
  for (const b of BANNED) if (lower.includes(b)) problems.push(`banned phrase: ${b}`);
  if (UNVERIFIABLE_COMPANY.test(content) && !(p.companyContext && UNVERIFIABLE_COMPANY.test(p.companyContext))) problems.push("unverified company claim");
  if (INVENTED_FAMILIARITY.test(content)) problems.push("invented familiarity with the company");
  // The role: when the job is known, the email must name exactly that job, and no other role.
  if (p.neutral && /software (engineer|developer)/i.test(content)) problems.push("assumes a Software Engineer role");
  if (p.roleFocus && !mentions(content, p.roleFocus)) problems.push("role focus missing");
  if (p.jobTitle) {
    const role = cleanTitle(p.jobTitle);
    if (!mentions(content, role)) problems.push("role title missing");
    for (const named of namedRoles(content)) if (!sameRole(named, role)) problems.push(`wrong role: ${named}`);
    if (!subjectFor(p).toLowerCase().includes(role.toLowerCase().replace(/\bintern$/i, "internship"))) problems.push("subject does not name the role");
  }
  // Company and job specifics must actually show up when they are available (no generic paragraphs).
  if (p.companyContext && !sharesWords(content, p.companyContext, 2, p.company)) problems.push("does not reflect the company");
  if (p.jobTitle && p.skillsInJob.length && !p.skillsInJob.some((s) => mentions(content, s))) problems.push("does not reflect the job requirements");
  // Technology claims must be the member's own; the job title, role label and company text may name any stack.
  for (const name of unverifiedSkills(content, p.memberId, [p.jobTitle ?? "", p.jobTitle ? cleanTitle(p.jobTitle) : "", p.roleFocus ?? "", p.roleLabel, p.company, p.companyContext ?? ""])) problems.push(`unverified skill: ${name}`);
  return [...new Set(problems)];
}
