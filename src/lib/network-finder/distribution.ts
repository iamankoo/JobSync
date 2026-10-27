import { MEMBER_IDS, type MemberId } from "@/config/members";

/**
 * Each day's 50 SELECTED contacts (one per company: the best contact found) are shared out as
 *   Anni 17 · Lukky 17 · Rishii 16  = 50 in total (not 50 each).
 * The assigned member is the one responsible for following that person up; the record itself stays owned by
 * the configured owner (Anni), and the outreach DRAFT still goes to all three members' Gmail.
 * Assignment interleaves through the day (the member furthest below their share goes next), so every batch
 * window gets a fair mix and a short day stays balanced.
 */
export const DAILY_DISTRIBUTION: Readonly<Record<MemberId, number>> = { anni: 17, lukky: 17, rishii: 16 };
export const DAILY_SELECTED_TARGET = Object.values(DAILY_DISTRIBUTION).reduce((a, b) => a + b, 0);

/** The member the next selected contact goes to, or null when every member's share for the day is full. */
export function nextAssignee(counts: Readonly<Partial<Record<MemberId, number>>>, shares: Readonly<Record<MemberId, number>> = DAILY_DISTRIBUTION): MemberId | null {
  let best: { m: MemberId; ratio: number } | null = null;
  for (const m of MEMBER_IDS) {
    const share = shares[m] ?? 0;
    const used = counts[m] ?? 0;
    if (share <= 0 || used >= share) continue;
    const ratio = used / share;
    if (!best || ratio < best.ratio) best = { m, ratio };
  }
  return best?.m ?? null;
}

/** One day's selected contact for one company (NF_Selections). */
export interface Selection {
  companyKey: string;
  /** Local date (APP_TIMEZONE) the selection counts toward. */
  date: string;
  connectionId: string;
  assignedTo: MemberId;
  contactName: string;
  email?: string;
  emailStatus: string;
  createdAt: string;
  /** Members whose Gmail draft exists (filled in by the draft step). */
  draftedFor: MemberId[];
}

export interface SelectionStore {
  get(companyKey: string): Promise<Selection | undefined>;
  forDay(date: string): Promise<Selection[]>;
  put(selection: Selection): Promise<void>;
  all(): Promise<Selection[]>;
}

export class InMemorySelectionStore implements SelectionStore {
  private map = new Map<string, Selection>();
  async get(key: string) {
    const s = this.map.get(key);
    return s ? { ...s, draftedFor: [...s.draftedFor] } : undefined;
  }
  async forDay(date: string) {
    return [...this.map.values()].filter((s) => s.date === date).map((s) => ({ ...s, draftedFor: [...s.draftedFor] }));
  }
  async put(s: Selection) {
    this.map.set(s.companyKey, { ...s, draftedFor: [...s.draftedFor] });
  }
  async all() {
    return [...this.map.values()].map((s) => ({ ...s, draftedFor: [...s.draftedFor] }));
  }
}

export function countsByMember(selections: readonly Selection[]): Partial<Record<MemberId, number>> {
  const out: Partial<Record<MemberId, number>> = {};
  for (const s of selections) out[s.assignedTo] = (out[s.assignedTo] ?? 0) + 1;
  return out;
}
