import type { MemberId } from "@/config/members";
import type { CallSignal, ChatMessage } from "@/types/domain";

/** A chat message as the browser sees it. `seq` is the server's ever-increasing cursor; `local` marks unsent ones. */
export interface ClientMessage extends ChatMessage {
  seq: number;
  local?: "sending" | "failed";
}

export interface ActiveCallInfo {
  callId: string;
  media: "audio" | "video";
  startedBy: MemberId;
  startedAt: string;
  participants: MemberId[];
}

export interface PollData {
  messages: (ChatMessage & { seq: number })[];
  cursor: number;
  lastReadRow: number;
  readers: Partial<Record<MemberId, number>>;
  recentCall: boolean;
  callsAvailable: boolean;
  call: { active: ActiveCallInfo | null; signals: CallSignal[]; cursor: string };
}
