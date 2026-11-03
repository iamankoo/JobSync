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

/** A well-formed public DNS name: never an IP literal, `localhost` or an internal suffix (a supplied address must not point a fetch inward). */
export function isPublicHostname(host: string): boolean {
  const h = host.toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h) || h.length > 253) return false;
  if (/^[0-9.]+$/.test(h)) return false;
  return !/\.(local|localhost|internal|intranet|lan|home|corp|test|invalid|example)$/.test(h);
}

/**
 * Company website as typed by a member -> a canonical http(s) URL (https added when the scheme is missing, fragment dropped).
 * Returns null when it is not a public website address. Never invents a URL: empty input is the caller's "absent".
 */
export function normalizeCompanyUrl(input: string): string | null {
  const t = input.trim();
  if (!t) return null;
  const url = parseHttpUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`);
  if (!url || !isPublicHostname(url.hostname)) return null;
  url.hash = "";
  return url.toString();
}
