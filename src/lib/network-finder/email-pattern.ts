/**
 * Predicting a contact's email from the company's OWN published pattern.
 *
 * Evidence = real addresses published on the company's public pages for NAMED people at the same domain
 * (e.g. "Jane Doe — jane.doe@acme.com" on the team page). A pattern is used only when every example agrees on
 * it (no conflicting example) and there are at least MIN_EXAMPLES. Generic inboxes (jobs@, hello@ …) are never
 * evidence. A predicted address is ALWAYS labelled "Predicted / Unverified" and is never shown as verified.
 */
export type EmailPattern = "first" | "first.last" | "firstlast" | "flast" | "f.last" | "first_last" | "firstl" | "last" | "last.first";

export const MIN_EXAMPLES = 1;

const PATTERNS: readonly EmailPattern[] = ["first.last", "first_last", "firstlast", "f.last", "flast", "firstl", "last.first", "first", "last"];
const GENERIC = /^(info|hello|hi|contact|team|jobs|careers|career|hr|recruiting|recruitment|talent|press|media|support|help|sales|admin|office|privacy|legal|security|billing|founders|hiring|apply|work|people)$/;

const ascii = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");

/** First and last name tokens ("Dr. Jane van der Berg" → jane / berg). Null when the name is a single word. */
export function nameParts(fullName: string): { first: string; last: string } | null {
  const tokens = fullName
    .replace(/\([^)]*\)/g, " ")
    .split(/[\s,]+/)
    .map(ascii)
    .filter((t) => t && !/^(dr|mr|mrs|ms|prof|jr|sr|ii|iii|phd|mba)$/.test(t));
  if (tokens.length < 2) return null;
  return { first: tokens[0], last: tokens[tokens.length - 1] };
}

export function applyPattern(p: EmailPattern, n: { first: string; last: string }): string {
  switch (p) {
    case "first": return n.first;
    case "first.last": return `${n.first}.${n.last}`;
    case "firstlast": return `${n.first}${n.last}`;
    case "flast": return `${n.first[0]}${n.last}`;
    case "f.last": return `${n.first[0]}.${n.last}`;
    case "first_last": return `${n.first}_${n.last}`;
    case "firstl": return `${n.first}${n.last[0]}`;
    case "last": return n.last;
    case "last.first": return `${n.last}.${n.first}`;
  }
}

export interface PatternEvidence {
  pattern: EmailPattern;
  domain: string;
  examples: string[];
}

/**
 * The domain's pattern from named, published examples — or null when there is no example, the examples
 * disagree, or the only match is ambiguous between patterns.
 */
export function inferPattern(examples: readonly { name: string; email: string }[], domain: string): PatternEvidence | null {
  const d = domain.toLowerCase();
  let candidates = null as Set<EmailPattern> | null;
  const used: string[] = [];
  for (const ex of examples) {
    const [local, host] = ex.email.toLowerCase().split("@");
    if (!local || host !== d || GENERIC.test(local)) continue;
    const n = nameParts(ex.name);
    if (!n) continue;
    const fits = new Set(PATTERNS.filter((p) => applyPattern(p, n) === local));
    if (fits.size === 0) return null; // a named person whose address follows none of the patterns: no reliable rule
    candidates = candidates ? new Set([...candidates].filter((p) => fits.has(p))) : fits;
    if (candidates.size === 0) return null; // examples disagree
    used.push(ex.email.toLowerCase());
  }
  if (!candidates || used.length < MIN_EXAMPLES) return null;
  // Several patterns fitting identically (e.g. "first" for a person whose first and last name are the same) = ambiguous.
  if (candidates.size !== 1) return null;
  return { pattern: [...candidates][0], domain: d, examples: used };
}

/** A predicted address for `name`, or null if the name cannot be split into first and last. */
export function predictEmail(name: string, evidence: PatternEvidence): string | null {
  const n = nameParts(name);
  return n ? `${applyPattern(evidence.pattern, n)}@${evidence.domain}` : null;
}

export const isGenericInbox = (email: string) => GENERIC.test(email.split("@")[0]?.toLowerCase() ?? "");
