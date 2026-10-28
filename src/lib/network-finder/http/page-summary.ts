/**
 * What a company's own homepage says about itself: title, site name and its own description (the meta / Open Graph
 * description). Pure string work; the text is decoded and cut, never rewritten.
 */
export interface PageSummary {
  title: string;
  siteName: string;
  description: string;
  /** Visible text (scripts and styles removed). */
  text: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", ndash: "–", mdash: "—", hellip: "…" };

export function decodeEntitiesForResearch(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}

const metaContent = (html: string, attr: "name" | "property", value: string): string => {
  const tag = new RegExp(`<meta\\b[^>]*\\b${attr}\\s*=\\s*["']${value}["'][^>]*>`, "i").exec(html)?.[0];
  if (!tag) return "";
  return decodeEntitiesForResearch(/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag)?.slice(1).find(Boolean) ?? "");
};

export function extractPageSummary(html: string): PageSummary {
  const title = decodeEntitiesForResearch(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "");
  const siteName = metaContent(html, "property", "og:site_name");
  const description = metaContent(html, "name", "description") || metaContent(html, "property", "og:description");
  const text = decodeEntitiesForResearch(
    html
      .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " "),
  );
  return { title, siteName, description, text };
}
