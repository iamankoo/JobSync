"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MEMBER_IDS, type MemberId } from "@/config/members";
import { apiRequest } from "@/lib/client/api";
import type { CallSignal } from "@/types/domain";
import type { ActiveCallInfo } from "./types";
import type { UseChat } from "./use-chat";

/**
 * Audio/video calls: browser-to-browser WebRTC (media never touches our servers), full mesh for up to the three
 * members. Signalling goes through the chat's own API (see /api/chat/call), with the ICE candidates folded into
 * each offer/answer (no trickle) so each pair needs exactly one offer and one answer.
 *
 * Only public STUN servers are configured. Without a TURN relay a pair of members on networks that block direct
 * peer-to-peer traffic (some corporate or carrier-grade NAT networks) cannot connect; that case is reported as
 * "could not connect", never hidden.
 */
const ICE_SERVERS: RTCIceServer[] = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];
const GATHER_TIMEOUT_MS = 3_500;
const PING_MS = 15_000;
const CONNECT_WARN_MS = 20_000;
/** Video only: a modest size/rate keeps the offer small and the stream steady on phone and home connections. */
const VIDEO_CONSTRAINTS: MediaTrackConstraints = { facingMode: "user", width: { ideal: 640, max: 1280 }, height: { ideal: 360, max: 720 }, frameRate: { ideal: 24, max: 30 } };
const VIDEO_MAX_BITRATE = 800_000;
/** Video only: if the first attempt has not connected after this long, the offering side sends a fresh offer once. */
const VIDEO_RETRY_MS = 14_000;

/**
 * Video only: offer just VP8 and H.264 (every browser decodes one of them), without the extra codecs (VP9 profile
 * mismatches are a known cause of black video between different browsers) and with a much shorter description.
 */
function preferCommonVideoCodecs(pc: RTCPeerConnection): void {
  try {
    const caps = RTCRtpReceiver.getCapabilities?.("video")?.codecs;
    if (!caps) return;
    const keep = caps.filter((c) => /^video\/(VP8|H264)$/i.test(c.mimeType) || /^video\/(rtx)$/i.test(c.mimeType));
    if (!keep.some((c) => /VP8|H264/i.test(c.mimeType))) return;
    for (const t of pc.getTransceivers()) if (t.receiver.track.kind === "video") t.setCodecPreferences?.(keep);
  } catch {
    /* unsupported: the browser's defaults still work */
  }
}

function capVideoBitrate(pc: RTCPeerConnection): void {
  for (const s of pc.getSenders()) {
    if (s.track?.kind !== "video") continue;
    try {
      const p = s.getParameters();
      p.encodings = p.encodings?.length ? p.encodings : [{}];
      p.encodings[0].maxBitrate = VIDEO_MAX_BITRATE;
      void s.setParameters(p).catch(() => undefined);
    } catch {
      /* ignore */
    }
  }
}

export type CallPhase = "idle" | "starting" | "joining" | "active";
export type PeerState = "connecting" | "connected" | "failed";

export interface CallError {
  title: string;
  message: string;
}

export interface Peer {
  memberId: MemberId;
  state: PeerState;
  stream: MediaStream | null;
}

export interface UseCall {
  phase: CallPhase;
  media: "audio" | "video";
  callId: string | null;
  error: CallError | null;
  clearError: () => void;
  localStream: MediaStream | null;
  peers: Peer[];
  micOn: boolean;
  camOn: boolean;
  start: (media: "audio" | "video") => Promise<void>;
  join: (call: ActiveCallInfo, withVideo: boolean) => Promise<void>;
  leave: () => Promise<void>;
  /** True when this member started the live call (and so may end it for everyone). */
  isStarter: boolean;
  /** Starter only: ends the call for every participant. */
  endForAll: () => Promise<void>;
  /** Set when the call was ended by its starter while this member was in it. */
  endedNotice: string | null;
  toggleMic: () => void;
  toggleCam: () => void;
}

/** Turns a getUserMedia / WebRTC failure into something a person can act on. */
export function describeMediaError(err: unknown, wantVideo: boolean): CallError {
  const name = (err as { name?: string })?.name ?? "";
  const what = wantVideo ? "camera and microphone" : "microphone";
  if (typeof window !== "undefined" && !window.isSecureContext) return { title: "Calls need a secure connection", message: "Your browser only allows the microphone and camera on https pages." };
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return { title: "Calls aren't supported here", message: "This browser can't use the microphone or camera. Try Chrome, Edge, Firefox or Safari." };
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return { title: `Permission needed for your ${what}`, message: `Allow ${what} access for JobSync in your browser's site settings (the lock icon next to the address), then try again.` };
    case "NotFoundError":
    case "OverconstrainedError":
      return { title: `No ${wantVideo ? "camera or " : ""}microphone found`, message: `Connect a ${what} and try again${wantVideo ? ", or start an audio call instead" : ""}.` };
    case "NotReadableError":
    case "AbortError":
      return { title: `Your ${what} is busy`, message: "Another app or tab is using it. Close it and try again." };
    default:
      return { title: "The call could not start", message: "Something went wrong while starting your microphone or camera. Please try again." };
  }
}

const post = (body: Record<string, unknown>) =>
  apiRequest<{ call: ActiveCallInfo | null; at: string }>("/api/chat/call", { method: "POST", body: JSON.stringify(body) });

function waitForIce(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener("icegatheringstatechange", check);
      clearTimeout(t);
      resolve();
    };
    const check = () => pc.iceGatheringState === "complete" && done();
    const t = setTimeout(done, GATHER_TIMEOUT_MS);
    pc.addEventListener("icegatheringstatechange", check);
  });
}

export function useCall(me: MemberId, chat: Pick<UseChat, "setSignalHandler" | "setInCall" | "refresh" | "activeCall" | "pollTick">): UseCall {
  const [phase, setPhase] = useState<CallPhase>("idle");
  const [media, setMedia] = useState<"audio" | "video">("audio");
  const [callId, setCallId] = useState<string | null>(null);
  const [error, setError] = useState<CallError | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [peers, setPeers] = useState<Record<string, Peer>>({});
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [isStarter, setIsStarter] = useState(false);
  const [endedNotice, setEndedNotice] = useState<string | null>(null);
  const nullPolls = useRef(0);
  const activeSince = useRef(0);

  const local = useRef<MediaStream | null>(null);
  const pcs = useRef(new Map<MemberId, RTCPeerConnection>());
  const call = useRef<{ id: string; at: string } | null>(null);
  const pingTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const handled = useRef(new Set<string>());
  const phaseRef = useRef<CallPhase>("idle");
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  const setPeer = useCallback((memberId: MemberId, patch: Partial<Peer>) => {
    const base: Peer = { memberId, state: "connecting", stream: null };
    setPeers((prev) => ({ ...prev, [memberId]: { ...base, ...prev[memberId], ...patch } }));
  }, []);

  const closePeer = useCallback((memberId: MemberId) => {
    const pc = pcs.current.get(memberId);
    if (pc) {
      pc.onconnectionstatechange = null;
      pc.ontrack = null;
      pc.close();
      pcs.current.delete(memberId);
    }
    setPeers((prev) => {
      const next = { ...prev };
      delete next[memberId];
      return next;
    });
  }, []);

  const teardown = useCallback(() => {
    if (pingTimer.current) clearInterval(pingTimer.current);
    pingTimer.current = null;
    for (const id of [...pcs.current.keys()]) closePeer(id);
    local.current?.getTracks().forEach((t) => t.stop());
    local.current = null;
    setLocalStream(null);
    setPeers({});
    call.current = null;
    handled.current.clear();
    setCallId(null);
    setPhase("idle");
    chat.setInCall(false);
  }, [closePeer, chat]);

  const newPeer = useCallback(
    (remote: MemberId): RTCPeerConnection => {
      closePeer(remote);
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      pcs.current.set(remote, pc);
      setPeer(remote, { state: "connecting", stream: null });
      local.current?.getTracks().forEach((t) => pc.addTrack(t, local.current!));
      if ((local.current?.getVideoTracks().length ?? 0) > 0) {
        preferCommonVideoCodecs(pc);
        capVideoBitrate(pc);
      }
      pc.ontrack = (e) => {
        const stream = e.streams[0] ?? new MediaStream([e.track]);
        setPeer(remote, { stream });
        // A video track often unmutes (first frames) after the stream is already attached: re-render when it does.
        e.track.onunmute = () => setPeer(remote, { stream });
        stream.onaddtrack = () => setPeer(remote, { stream });
      };
      const warn = setTimeout(() => {
        if (pcs.current.get(remote) === pc && pc.connectionState !== "connected") setPeer(remote, { state: "failed" });
      }, CONNECT_WARN_MS + GATHER_TIMEOUT_MS);
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "connected") {
          clearTimeout(warn);
          setPeer(remote, { state: "connected" });
        } else if (pc.connectionState === "failed") {
          clearTimeout(warn);
          setPeer(remote, { state: "failed" });
        } else if (pc.connectionState === "disconnected") setPeer(remote, { state: "connecting" });
      };
      return pc;
    },
    [closePeer, setPeer],
  );

  const retryOffer = useRef<((remote: MemberId, retried?: boolean) => Promise<void>) | null>(null);
  const sendOffer = useCallback(
    async (remote: MemberId, retried = false): Promise<void> => {
      if (!call.current) return;
      const pc = newPeer(remote);
      await pc.setLocalDescription(await pc.createOffer());
      await waitForIce(pc);
      if (!call.current || pcs.current.get(remote) !== pc || !pc.localDescription) return;
      await post({ action: "offer", callId: call.current.id, to: remote, payload: JSON.stringify(pc.localDescription) });
      // Video calls only: one automatic fresh attempt if this one has not connected.
      if ((local.current?.getVideoTracks().length ?? 0) > 0 && !retried) {
        setTimeout(() => {
          if (call.current && pcs.current.get(remote) === pc && pc.connectionState !== "connected") void retryOffer.current?.(remote, true);
        }, VIDEO_RETRY_MS);
      }
    },
    [newPeer],
  );

  useEffect(() => {
    retryOffer.current = sendOffer;
  }, [sendOffer]);

  const answerOffer = useCallback(
    async (remote: MemberId, payload: string) => {
      if (!call.current) return;
      const pc = newPeer(remote);
      await pc.setRemoteDescription(JSON.parse(payload));
      await pc.setLocalDescription(await pc.createAnswer());
      await waitForIce(pc);
      if (!call.current || pcs.current.get(remote) !== pc || !pc.localDescription) return;
      await post({ action: "answer", callId: call.current.id, to: remote, payload: JSON.stringify(pc.localDescription) });
    },
    [newPeer],
  );

  // Signals from the chat poll.
  useEffect(() => {
    chat.setSignalHandler((signals: CallSignal[]) => {
      const mine = call.current;
      if (!mine || phaseRef.current !== "active") return;
      for (const s of signals) {
        if (s.callId !== mine.id || handled.current.has(s.signalId)) continue;
        handled.current.add(s.signalId);
        const from = s.from;
        if (from === me) continue;
        void (async () => {
          try {
            if (s.type === "join") {
              // The member who has been in the call longer (earlier server timestamp; ties by name) makes the offer.
              if (s.createdAt > mine.at || (s.createdAt === mine.at && me < from)) await sendOffer(from);
            } else if (s.type === "offer" && s.to === me) {
              await answerOffer(from, s.payload);
            } else if (s.type === "answer" && s.to === me) {
              const pc = pcs.current.get(from);
              if (pc && pc.signalingState === "have-local-offer") await pc.setRemoteDescription(JSON.parse(s.payload));
            } else if (s.type === "leave") {
              closePeer(from);
            }
          } catch {
            setPeer(from, { state: "failed" });
          }
        })();
      }
    });
    return () => chat.setSignalHandler(null);
  }, [chat, me, sendOffer, answerOffer, closePeer, setPeer]);

  const begin = useCallback(
    async (wantVideo: boolean, how: () => ReturnType<typeof post>, nextPhase: "starting" | "joining") => {
      if (phaseRef.current !== "idle") return;
      setError(null);
      setPhase(nextPhase);
      let stream: MediaStream;
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error("unsupported"), { name: "Unsupported" });
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: wantVideo ? VIDEO_CONSTRAINTS : false });
      } catch (err) {
        setError(describeMediaError(err, wantVideo));
        setPhase("idle");
        return;
      }
      local.current = stream;
      setLocalStream(stream);
      setMicOn(true);
      setCamOn(true);
      setMedia(wantVideo ? "video" : "audio");

      const res = await how();
      if (!res.ok) {
        stream.getTracks().forEach((t) => t.stop());
        local.current = null;
        setLocalStream(null);
        setPhase("idle");
        setError(
          res.code === "call_not_active"
            ? { title: "That call has ended", message: "Nobody is in it any more. You can start a new one." }
            : res.code === "call_in_progress"
              ? { title: "A call is already running", message: "Use the Join button on the call banner." }
              : { title: "The call could not start", message: res.message },
        );
        chat.refresh();
        return;
      }
      const info = res.data.call;
      if (!info) {
        teardown();
        return;
      }
      call.current = { id: info.callId, at: res.data.at };
      setIsStarter(info.startedBy === me);
      setEndedNotice(null);
      nullPolls.current = 0;
      activeSince.current = Date.now();
      setCallId(info.callId);
      setPhase("active");
      chat.setInCall(true);
      pingTimer.current = setInterval(() => void post({ action: "ping", callId: info.callId }), PING_MS);
      chat.refresh();
    },
    [chat, teardown, me],
  );

  const start = useCallback(
    async (m: "audio" | "video") => {
      await begin(m === "video", () => post({ action: "start", media: m }), "starting");
    },
    [begin],
  );

  const join = useCallback(
    async (info: ActiveCallInfo, withVideo: boolean) => {
      await begin(withVideo, () => post({ action: "join", callId: info.callId }), "joining");
    },
    [begin],
  );

  const leave = useCallback(async () => {
    const id = call.current?.id;
    teardown();
    if (id) await post({ action: "leave", callId: id });
    chat.refresh();
  }, [teardown, chat]);

  const endForAll = useCallback(async () => {
    const id = call.current?.id;
    teardown();
    if (id) await post({ action: "end", callId: id });
    chat.refresh();
  }, [teardown, chat]);

  // The starter ended the call: the live call disappears from the server's view while this member is still in it.
  // (Two consecutive empty polls, and not within the first seconds, so a stale read cannot drop anyone.)
  const live = chat.activeCall;
  const tick = chat.pollTick;
  const teardownRef = useRef(teardown);
  useEffect(() => {
    teardownRef.current = teardown;
  });
  useEffect(() => {
    if (phase !== "active") return;
    if (live) {
      nullPolls.current = 0;
      return;
    }
    nullPolls.current += 1;
    if (nullPolls.current >= 2 && Date.now() - activeSince.current > 8_000) {
      setEndedNotice("The person who started the call ended it for everyone.");
      teardownRef.current();
    }
  }, [live, phase, tick]);

  // Closing or navigating away ends this member's side of the call (best effort; the server also expires silent members).
  useEffect(() => {
    const bye = () => {
      const id = call.current?.id;
      if (!id) return;
      try {
        void fetch("/api/chat/call", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "leave", callId: id }) });
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("pagehide", bye);
    return () => {
      window.removeEventListener("pagehide", bye);
      bye();
      teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // If everyone else has gone, the server's call state disappears; nothing to do locally except stay until the member leaves.

  const toggleMic = useCallback(() => {
    const track = local.current?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setMicOn(track.enabled);
  }, []);

  const toggleCam = useCallback(() => {
    const track = local.current?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setCamOn(track.enabled);
  }, []);

  return {
    phase, media, callId, error, clearError: () => {
      setError(null);
      setEndedNotice(null);
    }, localStream,
    peers: MEMBER_IDS.filter((m) => m !== me && peers[m]).map((m) => peers[m]),
    micOn, camOn, start, join, leave, isStarter, endForAll, endedNotice, toggleMic, toggleCam,
  };
}
