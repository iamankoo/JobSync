import "server-only";
import { MEMBER_IDS, type MemberId } from "@/config/members";
import type { BacklogGatePort } from "@/lib/network-finder/draft-fanout";
import { accessFor, DRAFTS_ENDPOINT } from "./drafts";
import type { FetchLike } from "./oauth";
import { isParkedDetail } from "./draft-flags";
import { readDraftLedger } from "./store";

/**
 * Draft backlog protection, PER MEMBER. While 100 or more JobSync-generated e-mail drafts are sitting UNSENT in ONE member's Gmail Drafts folder,
 * no new draft is created for THAT member (Outreach and Network Finder both create drafts only through `distributeDrafts`, which asks this gate
 * for each member before creating that member's draft). The other members keep drafting. Sending is a separate step and is never gated: it
 * drains the backlog, and the member's drafting resumes by itself once their own count is below the limit.
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
  | {
      status: "ok";
      /** Sum of the eligible counts of the members that COULD be counted (see `unknown`). */
      pending: number;
      byMember: Record<MemberId, number>;
      parked: number;
      parkedByMember: Record<MemberId, number>;
      /** Members whose Drafts folder could not be listed (reason). Their own drafting is paused; the other members are unaffected. */
      unknown: Partial<Record<MemberId, string>>;
    }
  | { status: "unknown"; reason: string };

/**
 * PER MEMBER: each member's Gmail is counted on its own and the 100-draft limit applies to each member's own Drafts folder. A member whose folder cannot
 * be listed is "unknown" (their drafting fails closed) without stopping the other members. Only an unreadable draft ledger makes the whole count unknown.
 */
export async function countPendingGmailDrafts(ports: BacklogPorts, members: readonly MemberId[] = MEMBER_IDS): Promise<BacklogCount> {
  let ledger: readonly PendingLedgerDraft[];
  try {
    ledger = await ports.ledgerPending();
  } catch {
    return { status: "unknown", reason: "the draft ledger could not be read" };
  }
  const byMember = { anni: 0, lukky: 0, rishii: 0 } as Record<MemberId, number>;
  const parkedByMember = { anni: 0, lukky: 0, rishii: 0 } as Record<MemberId, number>;
  const unknown: Partial<Record<MemberId, string>> = {};
  for (const member of members) {
    const mine = ledger.filter((d) => d.memberId === member);
    let listed: MemberDrafts;
    try {
      listed = await ports.gmailDraftIds(member);
    } catch {
      listed = { status: "unavailable", reason: "Gmail could not be read" };
    }
    if (listed.status === "unavailable") {
      unknown[member] = `${member}'s Gmail drafts could not be counted (${listed.reason})`;
      continue;
    }
    // A member without a usable Gmail connection cannot be looked at: their ledger drafts cannot be shown to be gone, so they are counted (conservative).
    const ids = listed.status === "ok" ? listed.ids : null;
    const present = ids ? mine.filter((d) => ids.has(d.gmailDraftId)) : mine;
    const eligible = present.filter((d) => !isParkedDetail(d.detail));
    byMember[member] = eligible.length;
    parkedByMember[member] = present.length - eligible.length;
  }
  const counted = members.filter((m) => !unknown[m]);
  if (!counted.length) return { status: "unknown", reason: Object.values(unknown).join("; ") || "no member could be counted" };
  return {
    status: "ok",
    pending: counted.reduce((n, m) => n + byMember[m], 0),
    byMember,
    parked: counted.reduce((n, m) => n + parkedByMember[m], 0),
    parkedByMember,
    unknown,
  };
}

export interface BacklogVerdict {
  allowed: boolean;
  /** With a member: that member's own count. Without: the sum over the members that could be counted. null when it could not be obtained. */
  pending: number | null;
  reason: string;
}

export interface DraftBacklogGate extends BacklogGatePort {
  /**
   * `check(member)`: may THIS member get a new draft (their own Gmail below the limit and countable)? `check()`: may ANY member (used as a cheap pre-check
   * before the Connections are even read). Neither ever lets one member's backlog or unreadable Gmail stop another member.
   */
  check(member?: MemberId): Promise<BacklogVerdict>;
  /** Forgets the cached count (e.g. after the send step freed drafts): the next check recounts. */
  invalidate(): void;
  /** The last count obtained (for logging); null before the first one. */
  last(): BacklogCount | null;
}

export function createBacklogGate(opts: { ports: BacklogPorts; limit?: number; ttlMs?: number; now?: () => number }): DraftBacklogGate {
  const limit = opts.limit ?? DRAFT_BACKLOG_LIMIT;
  const ttl = opts.ttlMs ?? COUNT_TTL_MS;
  const now = opts.now ?? Date.now;
  const noneAdded = (): Record<MemberId, number> => ({ anni: 0, lukky: 0, rishii: 0 }) as Record<MemberId, number>;
  let memo: { at: number; count: BacklogCount; added: Record<MemberId, number> } | null = null;
  let inflight: Promise<BacklogCount> | null = null;

  const memberVerdict = (count: Extract<BacklogCount, { status: "ok" }>, added: Record<MemberId, number>, member: MemberId): BacklogVerdict => {
    const why = count.unknown[member];
    if (why) return { allowed: false, pending: null, reason: `drafting paused for ${member}: ${why}` };
    const pending = (count.byMember[member] ?? 0) + (added[member] ?? 0);
    return pending >= limit
      ? { allowed: false, pending, reason: `drafting paused for ${member}: ${pending} unsent drafts are waiting in ${member}'s Gmail (limit ${limit}); sending continues and ${member}'s drafting resumes below ${limit}` }
      : { allowed: true, pending, reason: `${member}: ${pending} unsent drafts waiting (limit ${limit})` };
  };
  const verdictOf = (count: BacklogCount, added: Record<MemberId, number>, member?: MemberId): BacklogVerdict => {
    if (count.status !== "ok") return { allowed: false, pending: null, reason: `drafting paused: ${count.reason}` };
    if (member) return memberVerdict(count, added, member);
    const each = MEMBER_IDS.map((m) => memberVerdict(count, added, m));
    const pending = MEMBER_IDS.filter((m) => !count.unknown[m]).reduce((n, m) => n + count.byMember[m] + (added[m] ?? 0), 0);
    return each.some((v) => v.allowed)
      ? { allowed: true, pending, reason: each.map((v) => v.reason).join("; ") }
      : { allowed: false, pending, reason: each.map((v) => v.reason).join("; ") };
  };

  return {
    async check(member?: MemberId) {
      const t = now();
      if (memo && t - memo.at < (memo.count.status === "ok" ? ttl : FAILURE_TTL_MS)) return verdictOf(memo.count, memo.added, member);
      // Concurrent checks in one process share a single count.
      inflight ??= countPendingGmailDrafts(opts.ports).finally(() => { inflight = null; });
      let count: BacklogCount;
      try {
        count = await inflight;
      } catch {
        count = { status: "unknown", reason: "the draft count failed" };
      }
      memo = { at: now(), count, added: noneAdded() };
      return verdictOf(count, memo.added, member);
    },
    noteCreated(n = 1, member?: MemberId) {
      if (!memo) return;
      // A draft whose member is not known is charged to every member (conservative: it can only pause drafting sooner, never later).
      for (const m of member ? [member] : MEMBER_IDS) memo.added[m] += n;
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
        // Gmail answers 204 (no content, no body) for a Drafts folder with no drafts at all: that is a complete, empty listing, not an unreadable answer.
        if (res.status === 204) return { status: "ok", ids };
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
