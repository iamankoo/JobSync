import "server-only";
import { after } from "next/server";
import type { MemberId } from "@/config/members";
import { ApiError } from "@/lib/api/responses";
import { DomainError } from "@/lib/google-sheets/errors";
import { readConnectionsLocated } from "@/lib/google-sheets/repositories";
import { existingDraftDeps } from "@/lib/network-finder/gateways";
import { loadNetworkFinderConfig } from "@/lib/network-finder/config";
import { draftKey, type MemberDraftOutcome } from "@/lib/network-finder/draft-fanout";
import { draftForContact, type DraftStepDeps } from "@/lib/network-finder/pipeline";
import type { Brain } from "@/lib/network-finder/providers/brain";
import { createNemotronBrain, loadNemotronConfig } from "@/lib/network-finder/providers/nemotron";
import type { Connection } from "@/types/domain";

export type ConnectionDraftResult = { skipped: "no_email" | "network_finder" } | { outcomes: MemberDraftOutcome[] };

/**
 * A MANUALLY added connection gets a personalised Gmail draft through the SAME step Network Finder uses
 * (`draftForContact`: Nemotron or the built-in writer, the member's full name and signature, the NF_Drafts ledger).
 *
 * - Mailbox: the member who added the connection (its owner, `memberId`) — the person who will send it.
 * - No email address: nothing is attempted.
 * - Network Finder contacts are skipped here: Network Finder drafts them itself (in every member's mailbox).
 * - Idempotent: the ledger key is the connection + mailbox, so a retry never creates a second draft.
 * - Never sends: only Gmail's drafts endpoint is used.
 */
export async function draftForManualConnection(c: Connection, deps: { brain?: Brain; drafts?: DraftStepDeps } = {}): Promise<ConnectionDraftResult> {
  if (!c.email?.trim()) return { skipped: "no_email" };
  if ((c.notes ?? "").startsWith("Source: Network Finder")) return { skipped: "network_finder" };
  const nemotron = deps.brain ? null : loadNemotronConfig();
  const brain = deps.brain ?? (nemotron ? createNemotronBrain(nemotron) : undefined);
  const outcomes = await draftForContact(
    { config: loadNetworkFinderConfig(), ...(brain ? { brain } : {}), drafts: { ...(deps.drafts ?? existingDraftDeps()), members: [c.memberId] } },
    { connectionId: c.connectionId, name: c.name, title: c.role ?? "", email: c.email.trim(), company: { name: c.company?.trim() || "your team" } },
  );
  return { outcomes };
}

// ---- "Create Gmail Draft" (catch-up / retry from a connection's details) ------------------------------------

export type OwnDraftStatus = "none" | "created" | "sent" | "failed" | "skipped_unauthorized" | "deleted";

async function ownConnection(memberId: MemberId, connectionId: string): Promise<Connection> {
  const hit = (await readConnectionsLocated({ fresh: true })).items.find((i) => i.value.connectionId === connectionId)?.value;
  if (!hit) throw new DomainError("connection_not_found", "Connection not found.");
  // Only the member who added it may draft about it, and only into their own mailbox.
  if (hit.memberId !== memberId) throw new DomainError("not_connection_owner", "Only the member who added this connection can create its Gmail draft.");
  return hit;
}

/** The state of the SESSION member's draft for one of their own connections (for the details dialog). */
export async function ownDraftStatus(memberId: MemberId, connectionId: string, ledger: Pick<DraftStepDeps["ledger"], "get"> = existingDraftDeps().ledger): Promise<{ status: OwnDraftStatus; hasEmail: boolean }> {
  const c = await ownConnection(memberId, connectionId);
  const entry = await ledger.get(draftKey({ type: "contact", id: c.connectionId }, memberId));
  return { status: (entry?.status as OwnDraftStatus | undefined) ?? "none", hasEmail: Boolean(c.email?.trim()) };
}

export type OwnDraftResult = "created" | "already_drafted";

/**
 * Creates (or retries) the SESSION member's draft for one of their OWN connections, in their own Gmail, through the
 * same step as everywhere else. An existing created/sent draft is never duplicated ("already_drafted"); a failed,
 * skipped or deleted one is retried under the same ledger key (still one draft per connection + mailbox).
 */
export async function createOwnConnectionDraft(memberId: MemberId, connectionId: string, deps: { brain?: Brain; drafts?: DraftStepDeps } = {}): Promise<OwnDraftResult> {
  const c = await ownConnection(memberId, connectionId);
  if (!c.email?.trim()) throw new ApiError(400, "no_email", "Add an email address to this connection first.");
  const drafts = deps.drafts ?? existingDraftDeps();
  // A draft that exists, or was already SENT, is never written again (the shared step only checks "created").
  const existing = await drafts.ledger.get(draftKey({ type: "contact", id: c.connectionId }, memberId));
  if (existing?.status === "created" || existing?.status === "sent") return "already_drafted";
  const nemotron = deps.brain ? null : loadNemotronConfig();
  const brain = deps.brain ?? (nemotron ? createNemotronBrain(nemotron) : undefined);
  const [outcome] = await draftForContact(
    { config: loadNetworkFinderConfig(), ...(brain ? { brain } : {}), drafts: { ...drafts, members: [memberId] } },
    { connectionId: c.connectionId, name: c.name, title: c.role ?? "", email: c.email.trim(), company: { name: c.company?.trim() || "your team" } },
  );
  if (outcome?.result === "created" || outcome?.result === "already_drafted") return outcome.result;
  if (outcome?.result === "not_authorized" || outcome?.result === "reauth_required") {
    throw new ApiError(409, "gmail_not_connected", outcome.result === "reauth_required" ? "Your Gmail needs reconnecting (Profile → Gmail). No draft was created." : "Connect your Gmail first (Profile → Gmail). No draft was created.");
  }
  throw new ApiError(502, "draft_failed", "The Gmail draft could not be created. Please try again.");
}

/** Runs the draft after the HTTP response (the save never waits for Nemotron or Gmail). A failure is logged by name only. */
export async function draftAfterConnectionCreated(c: Connection): Promise<void> {
  const task = async () => {
    try {
      await draftForManualConnection(c);
    } catch (err) {
      console.error("[connections] Gmail draft could not be created", err instanceof Error ? err.name : typeof err);
    }
  };
  try {
    after(task);
  } catch {
    await task(); // outside a request (tests, scripts)
  }
}
