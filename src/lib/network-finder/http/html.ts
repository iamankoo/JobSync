/**
 * Minimal, dependency-free HTML reading for public pages: visible text, links and published email
 * addresses. Only what is literally on the page is returned.
 */
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k.startsWith("#x")) return String.fromCodePoint(parseInt(k.slice(2), 16) || 32);
    if (k.startsWith("#")) return String.fromCodePoint(Number(k.slice(1)) || 32);
    return ENTITIES[k] ?? m;
  });
}

/** Visible text: scripts, styles, svg and comments removed; block elements become line breaks. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<\/?(p|div|section|article|li|ul|ol|h[1-6]|br|tr|td|th|header|footer|nav|main|aside|figure|figcaption|dd|dt|blockquote)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

export interface PageLink {
  href: string;
  text: string;
}

/** Absolute http(s) and mailto links with their anchor text. */
export function extractLinks(html: string, baseUrl: string): PageLink[] {
  const out: PageLink[] = [];
  const re = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const raw = decodeEntities((m[1] ?? m[2] ?? m[3] ?? "").trim());
    if (!raw || raw.startsWith("#") || /^javascript:/i.test(raw)) continue;
    let href: string;
    try {
      href = raw.toLowerCase().startsWith("mailto:") ? raw : new URL(raw, baseUrl).toString();
    } catch {
      continue;
    }
    if (!/^(https?:|mailto:)/i.test(href)) continue;
    const text = htmlToText(m[4]).replace(/\s+/g, " ").slice(0, 120);
    // aria-label / title often name the person behind an icon-only LinkedIn link.
    const label = /\b(?:aria-label|title)\s*=\s*"([^"]{1,120})"/i.exec(m[0])?.[1];
    out.push({ href, text: text || (label ? decodeEntities(label) : "") });
  }
  return out;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}/g;
const NOT_EMAIL = /\.(png|jpe?g|gif|svg|webp|css|js)$/i;

/** Email addresses published in the text or as mailto links (lower-cased, unique). */
export function extractEmails(text: string, links: readonly PageLink[] = []): string[] {
  const found = new Set<string>();
  for (const m of text.match(EMAIL) ?? []) if (!NOT_EMAIL.test(m)) found.add(m.toLowerCase().replace(/\.$/, ""));
  for (const l of links) {
    if (!l.href.toLowerCase().startsWith("mailto:")) continue;
    const addr = decodeURIComponent(l.href.slice(7).split("?")[0]).trim().toLowerCase();
    if (/^[^@\s]+@[^@\s]+\.[a-z]{2,24}$/.test(addr)) found.add(addr);
  }
  return [...found];
}

/** Registrable-ish host for same-company checks: "www.acme.com" → "acme.com". */
export const bareHost = (url: string): string | null => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
};

/** Same site: identical host, or one is a subdomain of the other (jobs.acme.com / acme.com). */
export function sameSite(a: string, b: string): boolean {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

export const normalizeSpace = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
