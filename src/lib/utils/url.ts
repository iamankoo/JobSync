const TRACKING_PARAMS = new Set([
  "gclid", "fbclid", "msclkid", "dclid", "yclid", "igshid",
  "ref", "ref_src", "referrer", "source", "trk", "trackingid", "refid", "mc_cid", "mc_eid", "_hsenc", "_hsmi",
]);

export const MAX_URL_LENGTH = 2048;

function isTracking(name: string): boolean {
  const n = name.toLowerCase();
  return n.startsWith("utm_") || TRACKING_PARAMS.has(n);
}

/**
 * Parses an http(s) URL. Returns null for anything else (other schemes, credentials, garbage).
 */
export function parseHttpUrl(input: string): URL | null {
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (!url.hostname.includes(".")) return null;
  return url;
}

/**
 * Canonical form used ONLY for duplicate detection: lower-case scheme/host, no "www.",
 * no default port, no fragment, no tracking parameters, sorted query, no trailing slash,
 * and http/https treated as the same. Returns null if the URL is invalid.
 */
export function normalizeJobUrl(input: string): string | null {
  const url = parseHttpUrl(input);
  if (!url) return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const port = url.port && url.port !== "80" && url.port !== "443" ? `:${url.port}` : "";
  let path = url.pathname.replace(/\/{2,}/g, "/");
  if (path.length > 1) path = path.replace(/\/+$/, "");
  const params = [...url.searchParams.entries()]
    .filter(([k]) => !isTracking(k))
    .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : "";
  return `${host}${port}${path}${query}`;
}
