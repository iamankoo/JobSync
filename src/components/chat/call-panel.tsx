"use client";

import { useEffect, useRef } from "react";
import { AlertTriangle, Loader2, Mic, MicOff, PhoneCall, PhoneOff, Video, VideoOff, X } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { getMember, type MemberId } from "@/config/members";
import type { ActiveCallInfo } from "@/lib/chat/types";
import type { CallError, Peer, UseCall } from "@/lib/chat/use-call";

function Tile({ memberId, stream, local, state, video }: { memberId: MemberId; stream: MediaStream | null; local?: boolean; state?: Peer["state"]; video: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  const member = getMember(memberId);
  useEffect(() => {
    const el = ref.current;
    if (el && el.srcObject !== stream) el.srcObject = stream;
  }, [stream]);
  const showVideo = video && !!stream && stream.getVideoTracks().length > 0;
  return (
    <div className="relative grid aspect-video min-w-0 place-items-center overflow-hidden rounded-xl border border-line bg-navy-950" data-testid={local ? "call-tile-local" : `call-tile-${memberId}`} data-state={state ?? "local"}>
      {/* Remote audio plays through this element too, so it always exists (just hidden for audio-only calls). */}
      <video ref={ref} autoPlay playsInline muted={!!local} className={showVideo ? `h-full w-full object-cover ${local ? "-scale-x-100" : ""}` : "absolute h-px w-px opacity-0"} />
      {!showVideo && member && (
        <div className="flex flex-col items-center gap-2 p-2">
          <Avatar member={member} size={56} ring />
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-black/70 to-transparent px-2.5 py-1.5 text-xs font-semibold">
        <span className="truncate">{local ? "You" : member?.name}</span>
        {!local && state === "connecting" && (
          <span className="flex items-center gap-1 text-amber-300">
            <Loader2 size={12} className="animate-spin" aria-hidden /> Connecting…
          </span>
        )}
        {!local && state === "failed" && (
          <span className="flex items-center gap-1 text-red-300" title="Your networks may block direct calls between you">
            <AlertTriangle size={12} aria-hidden /> Couldn&apos;t connect
          </span>
        )}
      </div>
    </div>
  );
}

export function CallErrorNotice({ error, onDismiss }: { error: CallError; onDismiss: () => void }) {
  return (
    <div role="alert" data-testid="call-error" className="mx-3 mt-3 flex items-start gap-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2.5 text-sm text-red-100 sm:mx-4">
      <AlertTriangle size={18} className="mt-0.5 shrink-0 text-red-300" aria-hidden />
      <div className="flex-1">
        <p className="font-semibold">{error.title}</p>
        <p className="mt-0.5 opacity-90">{error.message}</p>
      </div>
      <button type="button" onClick={onDismiss} aria-label="Dismiss" className="rounded p-0.5 opacity-80 hover:opacity-100">
        <X size={16} aria-hidden />
      </button>
    </div>
  );
}

/** Shown while a call is live and this member is not in it. */
export function CallBanner({ call, me, onJoin, disabled }: { call: ActiveCallInfo; me: MemberId; onJoin: (withVideo: boolean) => void; disabled: boolean }) {
  const who = call.startedBy === me ? "You" : (getMember(call.startedBy)?.name ?? "Someone");
  const names = call.participants.map((p) => getMember(p)?.name).filter(Boolean).join(", ");
  return (
    <div role="status" data-testid="call-banner" className="mx-3 mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2.5 text-sm sm:mx-4">
      <PhoneCall size={18} className="shrink-0 text-emerald-300" aria-hidden />
      <p className="min-w-0 flex-1">
        <span className="font-semibold">{who} started {call.media === "video" ? "a video" : "an audio"} call.</span> <span className="text-muted">In the call: {names}</span>
      </p>
      <div className="flex gap-2">
        <button type="button" disabled={disabled} onClick={() => onJoin(call.media === "video")} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 font-semibold text-black hover:brightness-110 disabled:opacity-60">
          {call.media === "video" ? <Video size={15} aria-hidden /> : <PhoneCall size={15} aria-hidden />} Join{call.media === "video" ? " with video" : ""}
        </button>
        {call.media === "video" && (
          <button type="button" disabled={disabled} onClick={() => onJoin(false)} className="rounded-lg border border-emerald-500/50 px-3 py-1.5 font-semibold hover:bg-emerald-500/10 disabled:opacity-60">
            Audio only
          </button>
        )}
      </div>
    </div>
  );
}

/** The live call: tiles for you and everyone connected, and the controls. */
export function CallPanel({ me, call }: { me: MemberId; call: UseCall }) {
  const video = call.media === "video" || (call.localStream?.getVideoTracks().length ?? 0) > 0;
  const tiles = call.peers.length + 1;
  return (
    <section aria-label="Call in progress" data-testid="call-panel" className="mx-3 mt-3 rounded-xl border border-line bg-navy-800/60 p-2.5 sm:mx-4 sm:p-3">
      <div className={`grid gap-2.5 ${tiles === 1 ? "grid-cols-1 sm:max-w-sm" : "grid-cols-2"} ${tiles === 3 ? "lg:grid-cols-3" : ""}`}>
        <Tile memberId={me} stream={call.localStream} local video={video} />
        {call.peers.map((p) => (
          <Tile key={p.memberId} memberId={p.memberId} stream={p.stream} state={p.state} video={video} />
        ))}
      </div>
      {call.peers.length === 0 && (
        <p className="mt-2.5 text-center text-sm text-muted" data-testid="call-waiting">
          {call.phase === "active" ? "Waiting for others to join…" : "Starting…"}
        </p>
      )}
      <div className="mt-3 flex items-center justify-center gap-3">
        <button type="button" onClick={call.toggleMic} aria-pressed={!call.micOn} aria-label={call.micOn ? "Mute microphone" : "Unmute microphone"} className={`grid h-12 w-12 place-items-center rounded-full border ${call.micOn ? "border-line bg-navy-900 hover:border-electric-soft" : "border-red-500/60 bg-red-500/20 text-red-200"}`}>
          {call.micOn ? <Mic size={20} aria-hidden /> : <MicOff size={20} aria-hidden />}
        </button>
        {(call.localStream?.getVideoTracks().length ?? 0) > 0 && (
          <button type="button" onClick={call.toggleCam} aria-pressed={!call.camOn} aria-label={call.camOn ? "Turn camera off" : "Turn camera on"} className={`grid h-12 w-12 place-items-center rounded-full border ${call.camOn ? "border-line bg-navy-900 hover:border-electric-soft" : "border-red-500/60 bg-red-500/20 text-red-200"}`}>
            {call.camOn ? <Video size={20} aria-hidden /> : <VideoOff size={20} aria-hidden />}
          </button>
        )}
        <button type="button" onClick={() => void call.leave()} aria-label="Leave call" className="inline-flex h-12 items-center gap-2 rounded-full bg-red-600 px-5 font-semibold text-white hover:bg-red-500">
          <PhoneOff size={20} aria-hidden /> Leave
        </button>
      </div>
    </section>
  );
}
