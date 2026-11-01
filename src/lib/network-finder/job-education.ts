/**
 * Education rule for the daily job search: the candidates are 2027 graduates of a Bachelor's in engineering/technology
 * (B.Tech / B.E.). Pure (no I/O).
 *
 * Three outcomes, kept apart on purpose:
 *  - "reject"     the listing states something that rules the candidates out: postgraduate-only (Master's, M.Tech, M.E.,
 *                 MBA, MSc, MCA, PhD…), a different degree (MBBS, B.Com, BBA…), or an explicit exclusion of B.Tech/B.E.
 *                 (a graduation year other than 2027 is rejected by the caller, which already reads the years);
 *  - "verified"   the listing names a degree the candidates hold (B.Tech / B.E. / Bachelor of Technology or Engineering, or a
 *                 Bachelor's in computer science / engineering / IT…) AND the 2027 batch;
 *  - "unverified" nothing rules the candidates out, but the degree and/or the year is not stated. A 2027 year alone is NOT
 *                 enough to verify (a 2027 Master's student must never qualify), and nothing is invented.
 */
export type EducationResult = { status: "reject"; reason: string } | { status: "verified"; note: string } | { status: "unverified"; reason: string };

const BTECH_RE = /\bb\.?\s?tech\b|\bbachelor(?:'?s)?\s+of\s+(?:technology|engineering)\b/i;
/** "B.E." / "BE/B.Tech": case-sensitive, and never the English word "be". */
const BE_RE = /\bB\.E\.?(?![A-Za-z])|\bBE\s*[/,]\s*B\.?\s?Tech\b|\bB\.?\s?Tech\s*[/,]\s*BE\b/;
const BACHELOR_FIELD_RE =
  /\bbachelor(?:'?s)?(?:\s+degree)?\s+(?:in|of)\s+(?:computer|software|information|electronics|electrical|engineering|technology|data|artificial|a\s+(?:technical|related))|\b(?:bs|b\.s\.|bsc|b\.sc\.?)\s+in\s+(?:computer|software|engineering|information|data)|\bdegree\s+in\s+(?:computer|engineering|software|information technology|a\s+(?:technical|related))/i;
const BACHELOR_GENERIC_RE = /\bbachelor|\bundergraduate|\bunder-graduate/i;

const POSTGRAD_RE =
  /\bm\.?\s?tech\b|\bm\.?\s?sc\b|\bmsc\b|\bmba\b|\bmca\b|\bpgdm\b|\bpost[- ]?graduate\b|\bmaster'?s?\b(?=\s+(?:degree|of|in|candidate|student|program|level)|\s*[/,)])|\bmasters\b(?=\s+(?:degree|candidate|student|program))|\bm\.?\s?s\.?\b(?=\s+(?:in|degree|candidate|student|program))|\bph\.?\s?d\b|\bdoctoral\b|\bdoctorate\b/i;
const ME_RE = /\bM\.E\.?(?![A-Za-z])/;
const OTHER_DEGREE_RE = /\bmbbs\b|\bbds\b|\bbams\b|\bb\.?\s?pharm\b|\bb\.?\s?com\b|\bbba\b|\bb\.?\s?ed\b|\bllb\b|\bb\.?\s?arch\b|\bb\.?\s?des\b/i;
const EXCLUDES_RE = /\b(?:not|exclud\w*|except|other than|ineligible)\b(?!\s+(?:only|limited|restricted|just))[^.\n]{0,40}\b(?:b\.?\s?tech|b\.e\b|engineering (?:students|graduates|degree)|undergraduates?|bachelor)/i;
const EXCLUDES_AFTER_RE = /\b(?:b\.?\s?tech|b\.e\b|engineering (?:students|graduates)|undergraduates?)\b[^.\n]{0,30}\b(?:are not|is not|not)\s+(?:eligible|allowed|accepted|considered|permitted)|\b(?:b\.?\s?tech|b\.e)\b[^.\n]{0,30}\b(?:ineligible|excluded)/i;
/** A sentence only counts as a requirement when it talks about who may apply (not, say, "our team includes PhDs"). */
const REQUIREMENT_CUE_RE = /\b(?:pursuing|enrolled|candidates?|students?|currently|required|requirement|must|degree|holding|completed|qualification|eligib\w*|open to|only|graduat\w*|applicants?)\b/i;

const sentences = (text: string) => text.split(/(?<=[.!?])\s+|\n+/).filter(Boolean);
const inRequirement = (text: string, re: RegExp) => sentences(text).some((s) => re.test(s) && REQUIREMENT_CUE_RE.test(s));

export function evaluateEducation(text: string, years: readonly number[]): EducationResult {
  const explicit = BTECH_RE.test(text) || BE_RE.test(text);
  const field = BACHELOR_FIELD_RE.test(text);
  const accepts = explicit || field || BACHELOR_GENERIC_RE.test(text);

  if ((EXCLUDES_RE.test(text) && !explicit) || EXCLUDES_AFTER_RE.test(text)) return { status: "reject", reason: "eligibility excludes B.Tech / B.E. candidates" };
  if (!accepts) {
    if (inRequirement(text, POSTGRAD_RE) || inRequirement(text, ME_RE)) return { status: "reject", reason: "postgraduate-only (Master's / M.Tech / M.E. / MBA / MSc / PhD)" };
    if (inRequirement(text, OTHER_DEGREE_RE)) return { status: "reject", reason: "requires a different degree (not B.Tech / B.E.)" };
  }
  if ((explicit || field) && years.includes(2027)) return { status: "verified", note: `${explicit ? "B.Tech / B.E." : "a technical bachelor's degree"} and the 2027 batch are stated` };
  const missing = [explicit || field ? "" : "degree", years.includes(2027) ? "" : "2027 batch"].filter(Boolean).join(" and ");
  return { status: "unverified", reason: `${missing} not stated: 2027 B.Tech / B.E. eligibility is not verified` };
}
