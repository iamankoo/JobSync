import type { Employment } from "./types";

/**
 * Target role profiles used for RELEVANCE MATCHING (not an allow-list of exact titles). Each family lists
 * the words that signal it, so related titles ("Analytics Engineer", "ML Engineer", "React Developer")
 * match too.
 */
export const TARGET_ROLES = [
  "Data Analyst", "Data Engineer", "AI Engineer", "AI/ML Engineer", "AI Applied Engineer", "Python Developer",
  "Backend Engineer", "Frontend Developer / Engineer", "Full Stack Engineer", "Software Development Engineer",
  "Software Engineer", "App Developer", "MERN Stack Engineer",
] as const;

interface RoleFamily {
  family: string;
  pattern: RegExp;
}

const FAMILIES: RoleFamily[] = [
  { family: "data-analyst", pattern: /\b(data|business|product|marketing)\s+analyst\b|\banalytics\b|\bbi\s+(analyst|developer)\b|\bbusiness intelligence\b/ },
  { family: "data-engineer", pattern: /\bdata\s+engineer|\banalytics engineer|\betl\b|\bdata platform\b/ },
  { family: "ai-ml", pattern: /\b(ai|a\.i\.|ml|machine learning|deep learning|llm|genai|gen ai|nlp|computer vision|applied scientist|mlops)\b/ },
  { family: "python", pattern: /\bpython\b|\bdjango\b|\bfastapi\b|\bflask\b/ },
  { family: "backend", pattern: /\bback[\s-]?end\b|\bserver[\s-]side\b|\bapi engineer\b|\bplatform engineer\b|\bnode(\.js|js)?\b|\bgolang\b|\bjava developer\b/ },
  { family: "frontend", pattern: /\bfront[\s-]?end\b|\breact(\.js|js)?\b|\bui engineer\b|\bweb developer\b|\bangular\b|\bvue\b/ },
  { family: "full-stack", pattern: /\bfull[\s-]?stack\b|\bmern\b|\bmean stack\b/ },
  { family: "app", pattern: /\b(mobile|ios|android|flutter|react native)\b|\bapp developer\b/ },
  { family: "software", pattern: /\bsoftware\s+(engineer(ing)?|developer|development)\b|\b(engineering|software|tech|technology|developer|coding) intern(ship)?\b|\bsde\b|\bswe\b|\bmember of technical staff\b|\bprogrammer\b|\bdeveloper\b|\bengineer\b/ },
];

/** Titles that are not realistic for fresh graduates. */
const SENIOR = /\b(senior|sr\.?|staff|principal|lead|manager|director|head|vp|vice president|architect|chief)\b/;
const JUNIOR = /\b(intern|internship|junior|jr\.?|graduate|new grad|entry[\s-]level|associate|trainee|apprentice|i)\b/;
/** Engineering titles that are not software roles (avoid "Mechanical Engineer" matching "engineer"). */
const NON_SOFTWARE = /\b(mechanical|civil|electrical|chemical|hardware|sales|solutions|support|field|manufacturing|process|quality|structural|biomedical)\s+engineer/;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9.+#/\s-]/g, " ").replace(/\s+/g, " ").trim();

export interface RoleMatch {
  relevant: boolean;
  /** Matched families, most specific first. */
  families: string[];
  /** 0–100: how well the title fits the target profiles for a fresher. */
  score: number;
  reason: string;
}

/** How relevant a job title is to the target profiles, for someone early in their career. */
export function matchRole(title: string): RoleMatch {
  const t = norm(title);
  if (!t) return { relevant: false, families: [], score: 0, reason: "empty title" };
  if (NON_SOFTWARE.test(t)) return { relevant: false, families: [], score: 0, reason: "not a software/data role" };
  const families = FAMILIES.filter((f) => f.pattern.test(t)).map((f) => f.family);
  if (families.length === 0) return { relevant: false, families, score: 0, reason: "no target profile matched" };
  const junior = JUNIOR.test(t);
  // "Member of Technical Staff" is a standard entry/mid-level title, not a "Staff" (senior) level.
  if (SENIOR.test(t.replace(/\bmember of technical staff\b/, "")) && !junior) return { relevant: false, families, score: 0, reason: "senior role" };
  // Generic "engineer"/"developer" alone is a weaker signal than a named profile.
  const specific = families.some((f) => f !== "software");
  const score = Math.min(100, (specific ? 70 : 50) + (junior ? 20 : 0) + Math.min(10, (families.length - 1) * 5));
  return { relevant: true, families, score, reason: `matches ${families.join(", ")}${junior ? " (early-career)" : ""}` };
}

/** Titles that are clearly not engineering/data roles for us, whatever else they say. */
const NON_ENGINEERING = /\b(sales|account (executive|manager)|business development|customer (support|success)|support (engineer|specialist)|marketing|community|communications|comms|recruit\w*|talent|people (partner|operations)|human resources|hr\b|product manager|product marketing|project manager|program manager|operations|office|finance (manager|analyst)|accountant|legal|counsel|designer|copywriter|content)\b/;

export type RuleVerdict = { verdict: "relevant" | "irrelevant" | "unsure"; reason: string };

/**
 * What the deterministic rules can say about a title on their own: a clear target role, clearly not for us
 * (senior or non-engineering), or unsure (left to the brain).
 */
export function ruleVerdict(title: string): RuleVerdict {
  const m = matchRole(title);
  if (m.relevant) return { verdict: "relevant", reason: m.reason };
  const t = norm(title);
  if (m.reason === "senior role" || m.reason === "not a software/data role" || m.reason === "empty title") return { verdict: "irrelevant", reason: m.reason };
  if (NON_ENGINEERING.test(t)) return { verdict: "irrelevant", reason: "not an engineering/data role" };
  if (SENIOR.test(t.replace(/\bmember of technical staff\b/, "")) && !JUNIOR.test(t)) return { verdict: "irrelevant", reason: "senior role" };
  return { verdict: "unsure", reason: m.reason };
}

/** Employment type from what the source said, else from the title. */
export function classifyEmployment(title: string, stated?: Employment): Employment {
  if (stated) return stated;
  const t = norm(title);
  if (/\b(intern|internship|co-op|coop|trainee|apprentice)\b/.test(t)) return "internship";
  if (/\bpart[\s-]?time\b/.test(t)) return "part_time";
  if (/\b(contract|contractor|freelance)\b/.test(t)) return "contract";
  return "full_time";
}
