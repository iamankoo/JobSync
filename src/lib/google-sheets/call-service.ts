import "server-only";
import { MEMBER_IDS, type MemberId } from "@/config/members";
import type { CallSignal, CallSignalType } from "@/types/domain";
import { nowIso } from "@/lib/utils/time";
import { DomainError } from "./errors";
import { newId } from "./ids";
import { withWriteLock } from "./lock";
import { appendCallSignal, deleteTabRows, readCallSignalsLocated } from "./repositories";

/** Signalling is polled fast while a call is being set up, so it uses a very short shared read. */
export const SIGNAL_CACHE_MS = 1_200;
/** A participant counts as present while their last sign of life is younger than this (pings are every ~15 s). */
export const PRESENCE_MS = 45_000;
/** A call older than this is over, whatever else the log says. */
export const CALL_MAX_MS = 3 * 3_600_000;
/** Signalling rows older than this are deleted when a new call starts. */
const KEEP_MS = 24 * 3_600_000;
export const MAX_PAYLOAD_CHARS = 32_000;

export type CallMedia = "audio" | "video";

export interface ActiveCall {
  callId: string;
  media: CallMedia;
  startedBy: MemberId;
  startedAt: string;
  /** Members currently present in the call. */
  participants: MemberId[];
}

const PRESENT_TYPES: readonly CallSignalType[] = ["start", "join", "ping", "offer", "answer"];

/** Derives the one active call (if any) from the signalling log. Pure: the log is the only state. */
export function deriveActiveCall(signals: readonly CallSignal[], now: Date): ActiveCall | null {
  const nowMs = now.getTime();
  const recent = signals.filter((s) => nowMs - Date.parse(s.createdAt) < CALL_MAX_MS);
  const starts = recent.filter((s) => s.type === "start").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const start of starts) {
    const ofCall = recent.filter((s) => s.callId === start.callId);
    if (ofCall.some((s) => s.type === "end")) continue;
    const participants = MEMBER_IDS.filter((m) => {
      const latest = ofCall.filter((s) => s.from === m && (PRESENT_TYPES.includes(s.type) || s.type === "leave")).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      return latest !== undefined && latest.type !== "leave" && nowMs - Date.parse(latest.createdAt) < PRESENCE_MS;
    });
    if (participants.length === 0) continue; // nobody is there any more: the call is over
    let media: CallMedia = "audio";
    try {
      media = JSON.parse(start.payload)?.media === "video" ? "video" : "audio";
    } catch {
      /* default audio */
    }
    return { callId: start.callId, media, startedBy: start.from, startedAt: start.createdAt, participants };
  }
  return null;
}

export interface CallState {
  active: ActiveCall | null;
  /** Signals for the active call that are addressed to the caller (or everyone) and were sent by someone else. */
  signals: CallSignal[];
  /** Newest createdAt seen for the active call; pass back as `since`. */
  cursor: string;
}

export async function getCallState(memberId: MemberId, since: string | null, now: Date = new Date(), options: { fresh?: boolean } = {}): Promise<CallState> {
  const { items } = await readCallSignalsLocated({ maxAgeMs: SIGNAL_CACHE_MS, fresh: options.fresh });
  const all = items.map((i) => i.value);
  const active = deriveActiveCall(all, now);
  if (!active) return { active: null, signals: [], cursor: since ?? "" };
  const ofCall = all.filter((s) => s.callId === active.callId);
  const signals = ofCall.filter((s) => s.from !== memberId && (!s.to || s.to === memberId) && s.type !== "ping" && (!since || s.createdAt > since));
  const cursor = ofCall.reduce((max, s) => (s.createdAt > max ? s.createdAt : max), since ?? "");
  return { active, signals: signals.sort((a, b) => a.createdAt.localeCompare(b.createdAt)), cursor };
}

export interface CallAction {
  action: "start" | "join" | "offer" | "answer" | "leave" | "ping";
  callId?: string;
  to?: MemberId;
  media?: CallMedia;
  payload?: string;
}

/** Appends one signalling event on behalf of `memberId`. Returns the call it applies to. */
export async function applyCallAction(memberId: MemberId, input: CallAction, now: Date = new Date()): Promise<{ call: ActiveCall | null; started?: boolean; at: string }> {
  return withWriteLock(async () => {
    const { items } = await readCallSignalsLocated({ fresh: true });
    const all = items.map((i) => i.value);
    const active = deriveActiveCall(all, now);
    const stamp = nowIso(now);
    const push = async (callId: string, type: CallSignalType, payload = "", to?: MemberId) => {
      const signal: CallSignal = { signalId: newId("sig"), callId, from: memberId, ...(to ? { to } : {}), type, payload, createdAt: stamp };
      await appendCallSignal(signal);
      all.push(signal);
    };

    if (input.action === "start") {
      if (active) throw new DomainError("call_in_progress", "A call is already in progress.", { callId: active.callId, media: active.media, startedBy: active.startedBy });
      // Housekeeping: drop old signalling rows (rows only ever matter while a call is live).
      const stale = items.filter((i) => now.getTime() - Date.parse(i.value.createdAt) > KEEP_MS).map((i) => i.row);
      if (stale.length) await deleteTabRows("callSignals", stale);
      const callId = newId("call");
      await push(callId, "start", JSON.stringify({ media: input.media === "video" ? "video" : "audio" }));
      return { call: deriveActiveCall(all, now), started: true, at: stamp };
    }

    // Everything else belongs to the call that is live right now.
    if (!active || active.callId !== input.callId) throw new DomainError("call_not_active", "That call is not active any more.");

    switch (input.action) {
      case "join":
        await push(active.callId, "join");
        break;
      case "ping":
        await push(active.callId, "ping");
        break;
      case "offer":
      case "answer":
        if (!input.to || input.to === memberId) throw new DomainError("validation_failed", "A target member is required.");
        if (!input.payload) throw new DomainError("validation_failed", "A session description is required.");
        await push(active.callId, input.action, input.payload, input.to);
        break;
      case "leave": {
        await push(active.callId, "leave");
        const left = deriveActiveCall(all, now);
        if (!left) await push(active.callId, "end");
        break;
      }
    }
    return { call: deriveActiveCall(all, now), at: stamp };
  });
}
