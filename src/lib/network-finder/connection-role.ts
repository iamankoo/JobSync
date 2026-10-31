/**
 * The job role a MANUALLY added connection is about, read from the description the member typed (the connection's
 * Notes, then its "Message to send"). The description is the primary source: "Hiring for Machine Learning Engineer –
 * Video Generation" means a Machine Learning Engineer email about video generation, never a generic Software Engineer one.
 *
 * Pure (no I/O). Nothing is assumed: a missing or ambiguous description yields `null` / `ambiguous`, and the caller
 * writes a neutral enquiry instead of inventing a role. The person's own designation (Connection.role, e.g.
 * "Engineering Manager") is a different thing and is never read here.
 */

export interface ConnectionRole {
  /** The role exactly as stated, in readable case, e.g. "Machine Learning Engineer". */
  title: string;
  /** What the role works on, e.g. "Video Generation" (the part after a dash / colon / "focused on"). */
  focus?: string;
  internship: boolean;
}

export type RoleReading = { status: "found"; role: ConnectionRole } | { status: "ambiguous"; roles: string[] } | { status: "missing" };

const NOUN = /^(engineer|engineers|engineering|developer|developers|intern|interns|internship|internships|analyst|scientist|programmer|architect|trainee|researcher)$/i;
/** Words that end the role phrase on its left side ("Hiring for …", "looking for a …", "role: …"). */
const LEFT_STOP = new Set([
  "hiring", "hire", "hires", "for", "a", "an", "the", "is", "are", "as", "we", "they", "he", "she", "our", "their", "role", "roles", "position", "positions",
  "opening", "openings", "vacancy", "looking", "seeking", "open", "new", "apply", "applying", "to", "at", "in", "on", "of", "and", "or", "with", "about",
  "referral", "referred", "wants", "want", "needs", "need", "recruiting", "interested", "interest", "regarding", "re", "job", "jobs", "opportunity", "opportunities",
  "also", "currently", "now", "is", "be", "being", "been", "was", "were", "has", "have", "had", "will", "can", "may", "might", "should", "would", "could",
]);
const NOT_A_FOCUS = /^(remote|hybrid|on-?site|full[- ]?time|part[- ]?time|contract|urgent|immediate|asap|fresher|freshers|2027|2026|batch|india|usa|us|uk)$/i;
const ACRONYMS = new Set(["ai", "ml", "llm", "llms", "nlp", "sde", "swe", "qa", "ui", "ux", "sre", "ar", "vr", "api", "etl", "bi", "sql", "it", "gpu", "cv", "rag"]);
const SPECIAL: Record<string, string> = { devops: "DevOps", mlops: "MLOps", devsecops: "DevSecOps" };
const SMALL = new Set(["and", "of", "for", "the", "in", "to", "&", "/"]);

const clean = (s: string) => s.replace(/https?:\/\/\S+/gi, " ").replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, " ").replace(/\s+/g, " ").trim();
const bare = (t: string) => t.replace(/^[("'“‘[]+|[)"'”’\].,;:!?]+$/g, "");

function titleCase(phrase: string): string {
  const lettersOnly = phrase.replace(/[^A-Za-z]/g, "");
  const allLower = lettersOnly === lettersOnly.toLowerCase();
  const allUpper = lettersOnly.length > 4 && lettersOnly === lettersOnly.toUpperCase();
  // Typed in normal case: keep the member's own spelling, only fixing standalone acronyms ("Ai Applied Engineer" -> "AI Applied Engineer").
  if (!allLower && !allUpper) return phrase.split(/\s+/).map((w) => (SPECIAL[bare(w).toLowerCase()] ? w.replace(/[A-Za-z]+/, SPECIAL[bare(w).toLowerCase()]) : ACRONYMS.has(bare(w).toLowerCase()) ? w.replace(/[A-Za-z]+/, (m) => m.toUpperCase()) : w)).join(" ");
  return phrase
    .toLowerCase()
    .split(/\s+/)
    .map((w, i) => (SPECIAL[bare(w)] ? SPECIAL[bare(w)] : ACRONYMS.has(bare(w)) ? w.toUpperCase() : SMALL.has(w) && i > 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

interface Found {
  title: string;
  focus?: string;
}

/** The role phrases of one clause, in order ("Machine Learning Engineer", "Technology, Data & AI Internship"). */
function phrasesIn(clause: string): Found[] {
  const tokens = clause.split(/\s+/).filter(Boolean);
  const out: Found[] = [];
  let i = 0;
  while (i < tokens.length) {
    if (!NOUN.test(bare(tokens[i]))) {
      i += 1;
      continue;
    }
    // The role noun, extended over a following noun ("Developer Intern", "Engineer Intern").
    let end = i;
    while (end + 1 < tokens.length && NOUN.test(bare(tokens[end + 1]))) end += 1;
    // Walk left over the words that belong to the title.
    let start = i;
    while (start > 0 && i - start < 6) {
      const prev = tokens[start - 1];
      const w = bare(prev).toLowerCase();
      if (LEFT_STOP.has(w) || /^[–—-]$/.test(prev)) break;
      // A sentence-internal comma before the word ends the title unless it is a list inside it ("Technology, Data & AI").
      start -= 1;
    }
    // "Engineering" alone is a department, not a role: it needs a qualifier or a role noun after it.
    const words = tokens.slice(start, end + 1);
    const nouns = words.filter((w) => NOUN.test(bare(w))).length;
    const phrase = words.join(" ").replace(/^[,;:\s]+/, "");
    const lastIsRoleNoun = /^(engineer|engineers|developer|developers|intern|interns|internship|internships|analyst|scientist|programmer|architect|trainee|researcher)$/i.test(bare(words[words.length - 1] ?? ""));
    const enough = words.length >= 2 && lastIsRoleNoun && !(nouns === words.length && words.length < 2);
    // Focus: "– Video Generation", ": Video Generation", "(Video Generation)", "focused on X", "for X" up to the clause end.
    let focus: string | undefined;
    const rest = tokens.slice(end + 1);
    if (rest.length) {
      const first = rest[0];
      const dash = /^[–—-]+$/.test(first) || /^[–—-]/.test(first);
      const paren = first.startsWith("(");
      const lead = /^(focus(ed|ing)?|working|specialis(ing|ed)|specializing|on|for)$/i.test(bare(first)) && /^(on|in|with)$/i.test(bare(rest[1] ?? "")) ;
      if (dash || paren || /[:]$/.test(tokens[end]) || lead) {
        const body: string[] = [];
        for (const t of rest.slice(dash && /^[–—-]+$/.test(first) ? 1 : lead ? 2 : 0)) {
          const w = bare(t).toLowerCase();
          if (["at", "with", "in", "who", "and", "she", "he", "they", "but"].includes(w) && body.length) break;
          body.push(t);
          if (/[)]$/.test(t) && paren) break;
          if (body.length >= 8) break;
        }
        const text = bare(body.join(" ").replace(/^[–—-]+\s*/, "").replace(/^\(|\)$/g, "")).trim();
        if (text.length >= 3 && !NOT_A_FOCUS.test(text)) focus = text;
      }
    }
    if (enough) out.push({ title: phrase.replace(/[,;:]+$/g, "").trim(), ...(focus ? { focus } : {}) });
    i = end + 1;
  }
  return out;
}

const roleKey = (s: string) => s.toLowerCase().replace(/\bintern(ship)?s?\b/g, "").replace(/[^a-z0-9]/g, "");

/** "Role: …", "Position: …", "Job title: …", "Hiring for: …": whatever follows the label IS the role, whatever it is. */
const LABELLED = /(?:^|[\n.;,]|\s{2,})\s*(?:job\s+)?(?:role|position|job title|opening|hiring for|applying for)\s*[:=]\s*([^\n.;]{2,90})/i;

function labelled(t: string): RoleReading | null {
  const m = LABELLED.exec(t);
  if (!m) return null;
  const raw = m[1].trim().replace(/\s*\((?:remote|hybrid|on-?site|full[- ]?time|part[- ]?time)\)\s*$/i, "");
  const paren = /^(.*?)\s*\(([^)]{2,60})\)\s*$/.exec(raw);
  const [head, ...tail] = (paren ? paren[1] : raw).split(/\s+[–—-]\s+|\s+\|\s+/);
  if (paren && !NOT_A_FOCUS.test(paren[2].trim())) tail.push(paren[2].trim());
  const parts = head.split(/\s+(?:or|and)\s+/i).map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1) return { status: "ambiguous", roles: parts.map(titleCase) };
  const title = titleCase(head.trim());
  if (!/[A-Za-z]{2,}/.test(title) || title.split(/\s+/).length > 9) return null;
  const focus = tail.join(" – ").trim();
  return { status: "found", role: { title, ...(focus && !NOT_A_FOCUS.test(focus) ? { focus: titleCase(focus) } : {}), internship: /\bintern(ship)?s?\b/i.test(title) } };
}

/** Reads the role out of a free-text description. */
export function extractRole(text: string | undefined): RoleReading {
  const t = clean(text ?? "");
  if (!t) return { status: "missing" };
  const explicit = labelled(t);
  if (explicit) return explicit;
  const found: Found[] = [];
  for (const clause of t.split(/(?<=[.!?;])\s+|\n+/)) found.push(...phrasesIn(clause.trim()));
  if (!found.length) return { status: "missing" };
  // The same role named twice is one role; two different roles are ambiguous (the member must say which).
  const distinct = found.filter((f, i) => found.findIndex((g) => roleKey(g.title) === roleKey(f.title)) === i);
  if (distinct.length > 1) return { status: "ambiguous", roles: distinct.map((d) => titleCase(d.title)) };
  const f = distinct[0];
  const title = titleCase(f.title);
  return { status: "found", role: { title, ...(f.focus ? { focus: titleCase(f.focus) } : {}), internship: /\bintern(ship)?s?\b/i.test(title) } };
}

/** Notes first (the description), then the suggested message. */
export function roleForConnection(c: { notes?: string; message?: string }): RoleReading {
  const fromNotes = extractRole(c.notes);
  if (fromNotes.status !== "missing") return fromNotes;
  return extractRole(c.message);
}
