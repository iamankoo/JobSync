import "server-only";
import { MEMBER_IDS, type MemberId } from "@/config/members";
import type { BacklogGatePort } from "@/lib/network-finder/draft-fanout";
import { accessFor, DRAFTS_ENDPOINT } from "./drafts";
import type { FetchLike } from "./oauth";
import { isParkedDetail } from "./draft-flags";
import { readDraftLedger } from "./store";

/**
 * Draft backlog protection. While 100 or more JobSync-generated e-mail drafts are sitting UNSENT in the three members' Gmail Drafts folders,
 * no new draft is created anywhere (Outreach and Network Finder both create drafts only through `distributeDrafts`, which asks this gate
 * once before an item's three-member fan-out begins). Sending is a separate step and is never gated: it drains the backlog, and drafting
 * resumes by itself once the count is below the limit.
 *
 * WHAT IS COUNTED: the drafts that really exist in Gmail right now. For every member, ONE paged `drafts.list` call (ids only) returns what is
 * in their Drafts folder; a draft counts when the draft ledger (NF_Drafts) says JobSync created it ("created", with its Gmail draft id) AND
 * that id is still present in that member's Gmail. So:
 *   - a draft that was sent (by JobSync or by hand) or deleted is gone from Gmail and is not counted, whatever the ledger still says;
 *   - drafts the members wrote themselves are never counted (they are not in the ledger);
 *   - an UNCERTAIN send whose draft is still in Gmail IS counted (it is unresolved, and the send workflow never resends it blindly);
 *   - EXISTING drafts count too, however old: every unsent JobSync draft in Gmail is in the count until the send step has classified it;
 *   - a draft that needs a person (flagged "review:" when drafted, or "parked:" by the send step because it is opted out, an invalid or duplicate
 *     recipient, has a missing/wrong resume or fails the content checks) stays untouched in Gmail but is NOT part of the ELIGIBLE backlog: it
 *     is reported separately as `parked`. Otherwise drafts that only a person can deal with would pause new drafting forever;
 *   - each member's drafts are counted separately (one Connection can have up to three pending drafts);
 *   - the Master Contacts tab is never read: the inputs are one tab read (NF_Drafts) and three small Gmail list calls.
 *
 * FAIL CLOSED: if any connected member's Drafts folder cannot be listed (HTTP error, timeout, no permission, too many pages), or the count
 * itself fails, the gate answers "paused". A count older than `ttlMs` is never trusted; it is recounted.
 */
export const DRAFT_BACKLOG_LIMIT = 100;
/** Gmail returns at most 500 drafts per page; beyond this many pages the folder is too large to count reliably, which counts as "cannot count". */
export const MAX_LIST_PAGES = 20;
/** A Gmail count is reused for this long (drafts created in the meantime are added to it at once). */
export const COUNT_TTL_MS = 30_000;
/** After a failed count, the next check waits this long before asking Gmail again (a failure is never cached as success). */
const FAILURE_TTL_MS = 10_000;

export interface PendingLedgerDraft {
  memberId: MemberId;
  gmailDraftId: string;
  detail: string;
}

export type MemberDrafts = { status: "ok"; ids: ReadonlySet<string> } | { status: "not_connected" } | { status: "unavailable"; reason: string };

export interface BacklogPorts {
  /** Drafts JobSync created and the ledger still shows as unsent ("created" with a Gmail draft id). */
  ledgerPending(): Promise<readonly PendingLedgerDraft[]>;
  /** The ids of the drafts really present in the member's Gmail Drafts folder. */
  gmailDraftIds(member: MemberId): Promise<MemberDrafts>;
}

export type BacklogCount =
  | { status: "ok"; pending: number; byMember: Record<MemberId, number>; parked: number }
  | { status: "unknown"; reason: string };

export async function countPendingGmailDrafts(ports: BacklogPorts, members: readonly MemberId[] = MEMBER_IDS): Promise<BacklogCount> {
  let ledger: readonly PendingLedgerDraft[];
  try {
    ledger = await ports.ledgerPending();
  } catch {
    return { status: "unknown", reason: "the draft ledger could not be read" };
  }
  const byMember = { anni: 0, lukky: 0, rishii: 0 } as Record<MemberId, number>;
  let parked = 0;
  for (const member of members) {
    const mine = ledger.filter((d) => d.memberId === member);
    let listed: MemberDrafts;
    try {
      listed = await ports.gmailDraftIds(member);
    } catch {
      listed = { status: "unavailable", reason: "Gmail could not be read" };
    }
    if (listed.status === "unavailable") return { status: "unknown", reason: `${member}'s Gmail drafts could not be counted (${listed.reason})` };
    // A member without a usable Gmail connection cannot be looked at: their ledger drafts cannot be shown to be gone, so they are counted (conservative).
    const ids = listed.status === "ok" ? listed.ids : null;
    const present = ids ? mine.filter((d) => ids.has(d.gmailDraftId)) : mine;
    const eligible = present.filter((d) => !isParkedDetail(d.detail));
    byMember[member] = eligible.length;
    parked += present.length - eligible.length;
  }
  return { status: "ok", pending: members.reduce((n, m) => n + byMember[m], 0), byMember, parked };
}

export interface BacklogVerdict {
  allowed: boolean;
  /** The combined count, or null when it could not be obtained. */
  pending: number | null;
  reason: string;
}

export interface DraftBacklogGate extends BacklogGatePort {
  check(): Promise<BacklogVerdict>;
  /** Forgets the cached count (e.g. after the send step freed drafts): the next check recounts. */
  invalidate(): void;
  /** The last count obtained (for logging); null before the first one. */
  last(): BacklogCount | null;
}

export function createBacklogGate(opts: { ports: BacklogPorts; limit?: number; ttlMs?: number; now?: () => number }): DraftBacklogGate {
  const limit = opts.limit ?? DRAFT_BACKLOG_LIMIT;
  const ttl = opts.ttlMs ?? COUNT_TTL_MS;
  const now = opts.now ?? Date.now;
  let memo: { at: number; count: BacklogCount; added: number } | null = null;
  let inflight: Promise<BacklogCount> | null = null;

  const verdictOf = (count: BacklogCount, added: number): BacklogVerdict => {
    if (count.status !== "ok") return { allowed: false, pending: null, reason: `drafting paused: ${count.reason}` };
    const pending = count.pending + added;
    return pending >= limit
      ? { allowed: false, pending, reason: `drafting paused: ${pending} unsent drafts are waiting in the members' Gmail (limit ${limit}); sending continues and drafting resumes below ${limit}` }
      : { allowed: true, pending, reason: `${pending} unsent drafts waiting (limit ${limit})` };
  };

  return {
    async check() {
      const t = now();
      if (memo && t - memo.at < (memo.count.status === "ok" ? ttl : FAILURE_TTL_MS)) return verdictOf(memo.count, memo.added);
      // Concurrent checks in one process share a single count.
      inflight ??= countPendingGmailDrafts(opts.ports).finally(() => { inflight = null; });
      let count: BacklogCount;
      try {
        count = await inflight;
      } catch {
        count = { status: "unknown", reason: "the draft count failed" };
      }
      memo = { at: now(), count, added: 0 };
      return verdictOf(count, 0);
    },
    noteCreated(n = 1) {
      if (memo) memo.added += n;
    },
    invalidate() {
      memo = null;
    },
    last() {
      return memo?.count ?? null;
    },
  };
}

/** The real ports: the draft ledger (NF_Drafts) and each member's own Gmail Drafts folder (read-only `drafts.list`, covered by gmail.compose). */
export function realBacklogPorts(injected?: FetchLike): BacklogPorts {
  // Resolved at call time (never captured when the gate is created), so the process-wide gate always uses the current global fetch.
  const fetchFn: FetchLike = injected ?? ((input, init) => globalThis.fetch(input, init));
  return {
    ledgerPending: async () =>
      // A count is a bookkeeping figure that is recounted every 30 s anyway: the ledger may be up to 20 s old (not re-read in full each time).
      [...(await readDraftLedger({ allowStaleMs: 20_000 })).values()]
        .filter((d) => d.status === "created" && d.gmailDraftId)
        .map((d) => ({ memberId: d.memberId, gmailDraftId: d.gmailDraftId, detail: d.detail })),
    gmailDraftIds: async (member) => {
      const access = await accessFor(member, fetchFn);
      if (!access.ok) return access.status === "failed" ? { status: "unavailable", reason: access.reason ?? "authorisation unavailable" } : { status: "not_connected" };
      const ids = new Set<string>();
      let pageToken = "";
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        let res: Response;
        try {
          res = await fetchFn(`${DRAFTS_ENDPOINT}?maxResults=500&fields=${encodeURIComponent("nextPageToken,drafts(id)")}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`, {
            method: "GET",
            headers: { Authorization: `Bearer ${access.token}` },
            signal: AbortSignal.timeout(15_000),
          });
        } catch {
          return { status: "unavailable", reason: "Gmail unavailable" };
        }
        if (!res.ok) return { status: "unavailable", reason: `Gmail answered ${res.status}` };
        const body = (await res.json().catch(() => null)) as { drafts?: { id?: string }[]; nextPageToken?: string } | null;
        if (!body) return { status: "unavailable", reason: "unreadable Gmail answer" };
        for (const d of body.drafts ?? []) if (d.id) ids.add(d.id);
        if (!body.nextPageToken) return { status: "ok", ids };
        pageToken = body.nextPageToken;
      }
      return { status: "unavailable", reason: "too many drafts to count" };
    },
  };
}

/**
 * Which ledger drafts still exist as real drafts in the member's Gmail, from the SAME `drafts.list` call the backlog gate uses (ids only, one paged call
 * per member). The send step asks this BEFORE reading or claiming a draft: a ledger draft that is not in the listing is not a pending draft (sent or
 * deleted outside JobSync), so it is skipped without a single further Gmail call and without spending the send time slice.
 *
 * It only ever says "absent" for a complete, successful listing. Any failure (HTTP error, timeout, no permission, too many pages, member not connected)
 * is "unknown", and "unknown" never skips anything: the normal, fully verified path runs instead. A listing is reused for `ttlMs`; a failure is not.
 */
export const PRESENCE_TTL_MS = 45_000;
export type DraftPresenceAnswer = "present" | "absent" | "unknown";
export interface DraftPresence {
  has(member: MemberId, gmailDraftId: string): Promise<DraftPresenceAnswer>;
  invalidate(): void;
}

export function createDraftPresence(opts: { list: (member: MemberId) => Promise<MemberDrafts>; ttlMs?: number; now?: () => number }): DraftPresence {
  const ttl = opts.ttlMs ?? PRESENCE_TTL_MS;
  const now = opts.now ?? Date.now;
  const memo = new Map<MemberId, { at: number; ids: ReadonlySet<string> | null }>();
  const inflight = new Map<MemberId, Promise<ReadonlySet<string> | null>>();
  const idsOf = async (member: MemberId): Promise<ReadonlySet<string> | null> => {
    const hit = memo.get(member);
    if (hit && now() - hit.at < (hit.ids ? ttl : FAILURE_TTL_MS)) return hit.ids;
    let running = inflight.get(member);
    if (!running) {
      running = (async () => {
        let listed: MemberDrafts;
        try {
          listed = await opts.list(member);
        } catch {
          listed = { status: "unavailable", reason: "Gmail could not be read" };
        }
        const ids = listed.status === "ok" ? listed.ids : null;
        memo.set(member, { at: now(), ids });
        return ids;
      })().finally(() => inflight.delete(member));
      inflight.set(member, running);
    }
    return running;
  };
  return {
    async has(member, gmailDraftId) {
      const ids = await idsOf(member);
      return ids === null ? "unknown" : ids.has(gmailDraftId) ? "present" : "absent";
    },
    invalidate() {
      memo.clear();
    },
  };
}

let sharedPresence: DraftPresence | undefined;
/** The process-wide presence check used by the production send step. */
export function getDraftPresence(): DraftPresence {
  return (sharedPresence ??= createDraftPresence({ list: (m) => realBacklogPorts().gmailDraftIds(m) }));
}

let shared: DraftBacklogGate | undefined;
/** The process-wide gate used by the production wiring (one count shared by the Outreach cycle and the Network Finder in the same instance). */
export function getDraftBacklogGate(): DraftBacklogGate {
  return (shared ??= createBacklogGate({ ports: realBacklogPorts() }));
}
