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
  description?: string;
  internship?: boolean;
  location?: string;
  workMode?: string;
}

export interface EmailInput {
  memberId: MemberId;
  company: { name: string; website?: string; description?: string };
  person?: { name: string; title?: string };
  recipientEmail?: string;
  job?: EmailJob;
}

export interface EmailPlan {
  memberId: MemberId;
  member: Pick<Member, "fullName" | "linkedinUrl" | "githubUrl">;
  templateId: TemplateId;
  templateVersion: number;
  company: string;
  companyContext?: string;
  /** The exact job title when known; otherwise null (the email then speaks of the role family). */
  jobTitle: string | null;
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

export const MAX_WORDS = 300;
export const MIN_WORDS = 180;
export const MIN_WORDS_ONE_HIGHLIGHT = 150;
export const MIN_WORDS_THIN_PROFILE = 90;
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
  return DEFAULT_TEMPLATE;
}

const companyKey = (s: string) => s.toLowerCase().replace(/\b(inc|llc|ltd|limited|pvt|private|corp|corporation|co|gmbh|technologies|technology|labs?)\b/g, "").replace(/[^a-z0-9]/g, "");

/** The company's best open job in Jobs (relevant for early-career roles, newest first), or undefined. */
export function jobForCompany(jobs: readonly Job[], companyName: string): EmailJob | undefined {
  const key = companyKey(companyName);
  if (!key) return undefined;
  const mine = jobs.filter((j) => companyKey(j.company) === key).sort((a, b) => Number(matchRole(b.jobRole).relevant) - Number(matchRole(a.jobRole).relevant) || b.addedAt.localeCompare(a.addedAt));
  const j = mine[0];
  return j ? { title: j.jobRole, ...(j.description ? { description: j.description } : {}), internship: j.jobType === "Internship", location: j.location, ...(j.workMode ? { workMode: j.workMode } : {}) } : undefined;
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

export function subjectFor(plan: Pick<EmailPlan, "jobTitle" | "roleLabel" | "internship" | "company">): string {
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
  const templateId = selectTemplate(input.job?.title, input.job?.description);
  const tpl: EmailTemplate = TEMPLATES_BY_ID.get(templateId)!;
  const jobText = `${input.job?.title ?? ""} ${input.job?.description ?? ""}`;
  const { skills, inJob } = matchSkills(templateId, profile, jobText);
  const highlights = pickHighlights(profile, skills, templateId);
  const own = new Set(profile.skills);
  // Template sentences are only used when they claim nothing the member has not verified.
  const honest = (text: string) => unverifiedSkills(text, input.memberId).length === 0;
  const areas = tpl.areas.filter((a) => a.skills.some((s) => own.has(s)) && honest(a.text)).slice(0, 3).map((a) => a.text);
  const supported = tpl.prioritySkills.filter((s) => own.has(s)).length >= 2 && honest(tpl.valueProposition);
  const firstName = recipientFirstName(input.person?.name);
  const internship = isInternship(input.job);
  const base = { jobTitle: input.job?.title?.trim() || null, roleLabel: tpl.roleLabel, internship, company: input.company.name.trim() };
  const remote = /remote/i.test(`${input.job?.workMode ?? ""} ${input.job?.location ?? ""}`);
  return {
    memberId: input.memberId,
    member: { fullName: m.fullName, linkedinUrl: m.linkedinUrl, githubUrl: m.githubUrl },
    templateId,
    templateVersion: tpl.version,
    ...base,
    companyContext: companyContextOf(input.company.description),
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
    motivation: honest(tpl.neutralMotivation) ? tpl.neutralMotivation : "the work your team is doing",
    contributeTo: honest(tpl.contributeTo) ? tpl.contributeTo : "your engineering team",
    mentionRemote: remote && Boolean(profile.location),
    guidance: tpl.guidance,
    // Fewer verified facts → shorter (but complete) emails, never padding.
    minWords: profile.highlights.length >= 2 ? MIN_WORDS : profile.highlights.length === 1 ? MIN_WORDS_ONE_HIGHLIGHT : MIN_WORDS_THIN_PROFILE,
  };
}

// ---- deterministic fallback (no AI) --------------------------------------------------------------------------------

const roleText = (p: EmailPlan) => (p.jobTitle ? `the ${cleanTitle(p.jobTitle)} ${p.internship && !/\bintern(ship)?\b/i.test(p.jobTitle) ? "internship" : "position"}` : `${p.roleLabel} opportunities`);

/** A complete, honest email body (paragraphs only, no greeting/sign-off) from the plan's verified facts. */
export function composeFallback(p: EmailPlan): string[] {
  const paras: string[] = [];
  let opening = `I am writing to express my interest in ${roleText(p)} at ${p.company}.`;
  if (p.education) opening += ` I am a ${p.education}${p.areas.length ? `, with hands-on experience in ${listJoin(p.areas)}.` : "."}`;
  else if (p.areas.length) opening += ` I have hands-on experience in ${listJoin(p.areas)}.`;
  paras.push(opening);

  if (p.skills.length) {
    let tech = `My technical background includes ${listJoin(p.skills)}.`;
    const [h1, h2] = p.highlights;
    if (h1) tech += ` ${h1.kind === "experience" ? `As ${h1.title}, I` : `I have worked on ${h1.title}, where I`} ${h1.didWhat}.`;
    if (h2) tech += ` ${h2.kind === "experience" ? `As ${h2.title}, I also` : `I also built ${h2.title}, where I`} ${h2.didWhat}.`;
    if (p.capabilities.length === 2) tech += ` These experiences have strengthened my ability to ${p.capabilities[0]} and ${p.capabilities[1]}.`;
    paras.push(tech);
  }

  const fit: string[] = [];
  if (p.valueProposition) fit.push(p.valueProposition);
  if (p.skillsInJob.length >= 2) fit.push(`The role's focus on ${listJoin(p.skillsInJob.slice(0, 2))} matches the work I have been doing.`);
  else if (!p.valueProposition) fit.push(`I am keen to build on my experience in this area and to learn from an experienced team.`);
  paras.push(fit.join(" "));

  let motivation = `What particularly interests me about ${p.company} is ${p.motivation}. I would welcome the opportunity to contribute to ${p.contributeTo} while continuing to grow as an engineer.`;
  if (p.mentionRemote) motivation += ` I am based in ${p.location} and comfortable working remotely.`;
  paras.push(motivation);

  paras.push("I would be glad to share my resume and to discuss how my background aligns with your team's needs. Thank you for your time and consideration.");
  return paras;
}

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
  if (!/thank you/i.test(paras[paras.length - 1] ?? "")) paras.push("Thank you for your time and consideration.");
  return `${p.greeting}\n\n${paras.join("\n\n")}\n\n${signatureFor(p)}`;
}

// ---- validation ------------------------------------------------------------------------------------------------------

const BANNED = [
  "perfect fit", "ideal candidate", "thrilled to apply", "exciting opportunity", "innovative company", "cutting-edge", "leverage", "leveraging",
  "passionate about leveraging", "i am confident my skills", "synergy", "rockstar", "ninja", "world-class",
];
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
  // Technology claims must be the member's own; the job title, role label and company text may name any stack.
  for (const name of unverifiedSkills(content, p.memberId, [p.jobTitle ?? "", p.jobTitle ? cleanTitle(p.jobTitle) : "", p.roleLabel, p.company, p.companyContext ?? ""])) problems.push(`unverified skill: ${name}`);
  return [...new Set(problems)];
}
