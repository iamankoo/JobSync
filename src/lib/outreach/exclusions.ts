import { normalizeDomain, normalizeEmail } from "@/lib/hr-master/normalize";

export interface Exclusion {
  value: string;
  reason: string;
}

/**
 * Opt-outs and exclusions, maintained by hand in the "Outreach Exclusions" tab. A value is a full e-mail address or a domain
 * (optionally written with a leading @); a domain also excludes its sub-domains. Returns the reason (or the matched value) when the
 * address is excluded, else null.
 */
export function isExcluded(email: string, entries: readonly Exclusion[]): string | null {
  const e = normalizeEmail(email).email;
  const domain = e.slice(e.lastIndexOf("@") + 1);
  for (const x of entries) {
    const v = x.value.trim().toLowerCase();
    if (!v) continue;
    if (v.includes("@") && !v.startsWith("@")) {
      if (normalizeEmail(v).email === e) return x.reason || v;
    } else {
      const d = normalizeDomain(v.replace(/^@/, ""));
      if (d && (domain === d || domain.endsWith("." + d))) return x.reason || d;
    }
  }
  return null;
}

/**
 * Hard recipient allowlist for controlled tests. Each entry is an exact address, or has a "*" in the LOCAL part that matches any run of
 * characters (e.g. "me+jobsync*@gmail.com"). An empty list means "no allowlist". Case-insensitive; the domain must match exactly.
 */
export function matchesAllowlist(email: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return true;
  const e = normalizeEmail(email).email;
  if (!e) return false;
  return patterns.some((p) => {
    const [local, domain] = p.toLowerCase().split("@");
    const [eLocal, eDomain] = e.split("@");
    if (domain !== eDomain) return false;
    const re = new RegExp("^" + local.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
    return re.test(eLocal);
  });
}
