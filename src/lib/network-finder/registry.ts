import type { CompanySourceId, QualifiedCompany, SizeTier, TargetCountry } from "./types";

/**
 * Every company the Network Finder has picked, so it is never processed as "new" twice and can be
 * re-checked later for new openings. Also records where each company came from (source + ID + URL) and
 * why it was chosen. Contacts and jobs themselves live in Connections and Jobs, not here.
 */
export interface CompanyRecord {
  key: string;
  name: string;
  domain?: string;
  website?: string;
  source: CompanySourceId;
  sourceId: string;
  sourceUrl?: string;
  country: TargetCountry;
  sizeTier: SizeTier;
  employeeCount?: number;
  remoteFriendly?: boolean;
  reasons: string[];
  status: "queued" | "processed" | "no_contacts" | "failed";
  firstSeenAt: string;
  lastProcessedAt?: string;
  lastJobCheckAt?: string;
  contactsSaved: number;
  jobsSaved: number;
  /** Public careers page / job board link, used to re-check openings. */
  careersUrl?: string;
}

export interface CompanyRegistry {
  get(key: string): Promise<CompanyRecord | undefined>;
  put(record: CompanyRecord): Promise<void>;
  all(): Promise<CompanyRecord[]>;
  /** Paging position per source, so discovery continues where it stopped. */
  getCursor(source: CompanySourceId): Promise<string | undefined>;
  setCursor(source: CompanySourceId, cursor: string | undefined): Promise<void>;
}

export class InMemoryCompanyRegistry implements CompanyRegistry {
  private records = new Map<string, CompanyRecord>();
  private cursors = new Map<CompanySourceId, string>();
  async get(key: string) {
    const r = this.records.get(key);
    return r ? { ...r, reasons: [...r.reasons] } : undefined;
  }
  async put(record: CompanyRecord) {
    this.records.set(record.key, { ...record, reasons: [...record.reasons] });
  }
  async all() {
    return [...this.records.values()].map((r) => ({ ...r, reasons: [...r.reasons] }));
  }
  async getCursor(source: CompanySourceId) {
    return this.cursors.get(source);
  }
  async setCursor(source: CompanySourceId, cursor: string | undefined) {
    if (cursor) this.cursors.set(source, cursor);
    else this.cursors.delete(source);
  }
}

export function recordFor(company: QualifiedCompany, nowIso: string): CompanyRecord {
  return {
    key: company.key, name: company.name, ...(company.domain ? { domain: company.domain } : {}), ...(company.website ? { website: company.website } : {}),
    source: company.source, sourceId: company.sourceId, ...(company.sourceUrl ? { sourceUrl: company.sourceUrl } : {}),
    country: company.country, sizeTier: company.sizeTier, employeeCount: company.employeeCount, remoteFriendly: company.remoteFriendly,
    reasons: company.reasons, status: "queued", firstSeenAt: nowIso, contactsSaved: 0, jobsSaved: 0,
    ...(company.careersUrl ? { careersUrl: company.careersUrl } : {}),
  };
}

/** Processed companies whose openings have not been checked for at least `intervalMs`, oldest first. */
export function dueForJobRecheck(records: readonly CompanyRecord[], now: number, intervalMs: number): CompanyRecord[] {
  return records
    .filter((r) => (r.status === "processed" || r.status === "no_contacts") && (!r.lastJobCheckAt || now - Date.parse(r.lastJobCheckAt) >= intervalMs))
    .sort((a, b) => (a.lastJobCheckAt ?? "").localeCompare(b.lastJobCheckAt ?? ""));
}
