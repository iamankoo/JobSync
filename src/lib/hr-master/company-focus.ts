/**
 * Company-level fallback classification for contacts whose role category is otherwise Unverified.
 * It only asks "what is this company primarily about?" (software vs AI) from the company's OWN headline text: page title,
 * site name, meta description and the opening of its About page. It never describes an individual's designation or a job
 * opening, and anything not clearly one or the other stays unclassified.
 */
import type { CompanyResearch } from "./types.ts";

export interface FocusInput {
  title?: string;
  siteName?: string;
  description?: string;
  /** Opening text of the company's About page (empty when none was read). */
  about?: string;
  /** Homepage visible-text sample (used only to reject pages that are clearly about something else). */
  textSample?: string;
}

export interface FocusResult {
  category: "Software Engineer" | "AI Engineer";
  /** Short quotes from the company's own text that justified the call. */
  signals: string[];
  /** Which text carried the evidence: "homepage" or "about". */
  from: "homepage" | "about";
}

const STRONG_AI = /\b(artificial intelligence|machine learning|deep learning|generative ai|gen ?ai|large language models?|llms?|computer vision|natural language processing|nlp|conversational ai|ai agents?|agentic|ai[- ](powered|first|native|driven|based|enabled|platform|company|startup|products?|solutions?|services?|lab|research|automation|assistant|copilot|infrastructure)|ai\/ml|ml\/ai|\bai\b(?= (and|&) (ml|data)))\b/gi;
const STRONG_SOFTWARE = /\b(software (development|engineering|products?|services|solutions|company|house|consult\w*|testing|platform)|custom software|saas|product engineering|application development|app development|mobile app (development|developers?)|web (application|app) development|enterprise software|digital engineering|software[- ]as[- ]a[- ]service|devops|it (services|solutions|consulting|company)|information technology (services|company)|erp (software|solutions)|cloud (software|platform|services|engineering|native)|api platform|developer (platform|tools))\b/gi;
const WEAK_SOFTWARE = /\b(web (development|design and development)|website development)\b/gi;
/** Sectors that make "web development"/"technology" mentions incidental unless a strong software/AI phrase is also present. */
const OTHER_SECTOR = /\b(marketing|advertis\w*|seo|staffing|recruit\w*|placement|manufactur\w*|pharma\w*|real estate|school|college|university|institute|hospital|clinic|bank|insurance|travel|tours?|fashion|restaurant|logistics|construction|hardware|devices?|monitors?|displays?|optical|semiconductors?|automotive|energy|textiles?|jewel\w*|furniture|agri\w*|consultancy for|law firm|chartered accountants?|trading|exporters?|importers?)\b/i;

function matches(re: RegExp, text: string): string[] {
  return [...new Set([...text.matchAll(new RegExp(re.source, re.flags))].map((m) => m[0].toLowerCase()))];
}

function classifyText(text: string): { ai: string[]; sw: string[]; weak: string[]; other: boolean } {
  return { ai: matches(STRONG_AI, text), sw: matches(STRONG_SOFTWARE, text), weak: matches(WEAK_SOFTWARE, text), other: OTHER_SECTOR.test(text) };
}

const SW_IDENTITY = /\b(software (development|engineering|products?|services|solutions|company|house|consult\w*)|custom software|saas|product engineering|application development|app development|mobile app (development|developers?)|software[- ]as[- ]a[- ]service)\b/i;

/**
 * "Primarily" is enforced by evidence strength: AI needs two distinct AI signals or one in the page title/site name (a
 * single "AI-powered" in a description is a product feature, not what the company is); software needs an identity phrase
 * ("software company", "custom software", "SaaS" ...) or two signals. A non-software sector word vetoes single weak signals.
 */
/** An explicit statement of what the company is; the only way a single signal is accepted from an About page. */
const ABOUT_IDENTITY = /\b((software|saas|it|app|mobile app|web|product engineering)( development)? (company|house|firm|studio|services company)|software product company|(ai|artificial intelligence|machine learning)[- ](company|startup|lab|first company)|we (build|develop|create) (custom )?(software|saas|ai))\b/i;

function decide(text: string, titleText: string, isAbout = false): Omit<FocusResult, "from"> | null {
  const t = classifyText(text);
  if (isAbout && !ABOUT_IDENTITY.test(text)) {
    // From an About page alone, a single incidental mention is not enough.
    if (t.ai.length < 2 && t.sw.length < 2) return null;
  }
  const aiInTitle = matches(STRONG_AI, titleText).length > 0;
  const aiOk = t.ai.length > 0 && t.ai.length >= t.sw.length && (t.ai.length >= 2 || aiInTitle) && !(t.other && t.ai.length < 2 && !aiInTitle);
  if (aiOk) return { category: "AI Engineer", signals: t.ai.slice(0, 4) };
  const swOk = t.sw.length >= 2 || t.sw.some((x) => SW_IDENTITY.test(x));
  if (swOk) return { category: "Software Engineer", signals: t.sw.slice(0, 4) };
  if (t.weak.length > 0 && !t.other) return { category: "Software Engineer", signals: t.weak.slice(0, 3) };
  return null;
}

/** Returns the company's primary focus if its own headline/About text states it clearly, else null (leave Unverified). */
export function classifyCompanyFocus(input: FocusInput): FocusResult | null {
  const titleText = [input.title, input.siteName].filter(Boolean).join(" . ");
  const headline = [titleText, input.description].filter(Boolean).join(" . ");
  const fromHome = headline ? decide(headline, titleText) : null;
  if (fromHome) return { ...fromHome, from: "homepage" };
  const about = (input.about ?? "").slice(0, 900);
  const fromAbout = about ? decide(about, "", true) : null;
  return fromAbout ? { ...fromAbout, from: "about" } : null;
}

export interface BodyFocus {
  category: "Software Engineer" | "AI Engineer";
  signals: string[];
}

/**
 * Stricter whole-homepage read, used only after the headline and About page said nothing. Needs THREE distinct signals of one
 * kind (and, for AI, at least as many as software, with no non-software sector word unless the title itself says AI), so a
 * company that merely mentions AI or software somewhere on its page is not classified.
 */
export function classifyFromBody(input: { title?: string; siteName?: string; description?: string; textSample?: string }): BodyFocus | null {
  const text = [input.title, input.siteName, input.description, input.textSample].filter(Boolean).join(" . ").slice(0, 6000);
  if (!text) return null;
  const titleText = [input.title, input.siteName].filter(Boolean).join(" . ");
  const t = classifyText(text);
  const aiInTitle = matches(STRONG_AI, titleText).length > 0;
  if (t.ai.length >= 3 && t.ai.length >= t.sw.length && (!t.other || aiInTitle)) return { category: "AI Engineer", signals: t.ai.slice(0, 5) };
  if (t.sw.length >= 3 && t.sw.length > t.ai.length && !t.other) return { category: "Software Engineer", signals: t.sw.slice(0, 5) };
  return null;
}

const NAME_AI = /(?<![.\w-])(ai|artificial intelligence|machine learning|deep learning|genai)(?![.\w-])/i;
const NAME_SOFTWARE = /\b(software|softwares|softech|saas)\b/i;

/** The company's own NAME states its field ("Acme Software Services", "Suki AI"). A ".ai" web suffix alone does not count. */
export function classifyFromName(companyName: string): { category: "Software Engineer" | "AI Engineer"; signal: string } | null {
  const name = (companyName ?? "").trim();
  if (!name) return null;
  const sw = NAME_SOFTWARE.exec(name);
  if (sw) return { category: "Software Engineer", signal: sw[0] };
  const ai = NAME_AI.exec(name);
  return ai ? { category: "AI Engineer", signal: ai[0] } : null;
}

export function headlineOf(r: Pick<CompanyResearch, "title" | "siteName" | "description">): string {
  return [r.title, r.siteName, r.description].filter(Boolean).join(" . ");
}
