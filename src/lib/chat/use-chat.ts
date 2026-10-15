"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MemberId } from "@/config/members";
import { apiRequest } from "@/lib/client/api";
import { setUnread } from "@/lib/chat/use-unread";
import type { CallSignal } from "@/types/domain";
import type { ActiveCallInfo, ClientMessage, PollData } from "./types";

/** Short polling: a Vercel function cannot hold a socket open, and Google Sheets is the only store. */
const POLL_VISIBLE_MS = 3_000;
const POLL_IN_CALL_MS = 1_500;
/** Signal cursors are re-read with this much overlap (de-duplicated by id) to tolerate clock skew between instances. */
const SIGNAL_OVERLAP_MS = 3_000;

export type ChatStatus = "loading" | "ready" | "unavailable" | "error";

export interface UseChat {
  status: ChatStatus;
  statusMessage: string;
  messages: ClientMessage[];
  /** Row of the last message this member had read when the chat was opened (for the "new messages" divider). */
  openedReadRow: number;
  activeCall: ActiveCallInfo | null;
  /** Increments on every poll while this member is in a call (so the call hook can count polls). */
  pollTick: number;
  callsAvailable: boolean;
  sendText: (text: string) => Promise<boolean>;
  retry: (localId: string) => void;
  uploadFile: (file: File, kind: "file" | "voice", extra?: { durationSec?: number; caption?: string }) => Promise<{ ok: true } | { ok: false; message: string }>;
  /** Pulls immediately (after sending, or when the tab becomes visible). */
  refresh: () => void;
  /** The call hook registers here to receive signals addressed to this member. */
  setSignalHandler: (fn: ((signals: CallSignal[]) => void) | null) => void;
  /** Poll faster while this is true (signalling during a call). */
  setInCall: (v: boolean) => void;
}

let localCounter = 0;

export function useChat(me: MemberId): UseChat {
  const [status, setStatus] = useState<ChatStatus>("loading");
  const [statusMessage, setStatusMessage] = useState("");
  const [messages, setMessages] = useState<ClientMessage[]>([]);
  const [openedReadRow, setOpenedReadRow] = useState(0);
  const [activeCall, setActiveCall] = useState<ActiveCallInfo | null>(null);
  const [callsAvailable, setCallsAvailable] = useState(true);
  const [pollTick, setPollTick] = useState(0);

  const cursor = useRef(0);
  const signalCursorMs = useRef(0);
  const seenSignals = useRef(new Set<string>());
  const lastReadSent = useRef(0);
  const inCall = useRef(false);
  const onSignals = useRef<((s: CallSignal[]) => void) | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const polling = useRef(false);
  const alive = useRef(true);
  const pollRef = useRef<() => Promise<void>>(async () => {});

  const markRead = useCallback(async (upTo: number) => {
    if (upTo <= lastReadSent.current) return;
    lastReadSent.current = upTo;
    setUnread(0);
    await apiRequest("/api/chat/read", { method: "POST", body: JSON.stringify({ upToRow: upTo }) });
  }, []);

  const schedule = useCallback((ms?: number) => {
    if (timer.current) clearTimeout(timer.current);
    if (!alive.current) return;
    timer.current = setTimeout(() => void pollRef.current(), ms ?? (inCall.current ? POLL_IN_CALL_MS : POLL_VISIBLE_MS));
  }, []);

  useEffect(() => {
    alive.current = true;
    let first = true;
    pollRef.current = async () => {
      if (polling.current || !alive.current) return;
      if (document.visibilityState === "hidden" && !inCall.current) return schedule(POLL_VISIBLE_MS * 2);
      polling.current = true;
      try {
        const since = signalCursorMs.current ? new Date(signalCursorMs.current - SIGNAL_OVERLAP_MS).toISOString() : "";
        const res = await apiRequest<PollData>(`/api/chat/poll?after=${cursor.current}${since ? `&since=${encodeURIComponent(since)}` : ""}`);
        if (!alive.current) return;
        if (!res.ok) {
          if (res.code === "chat_not_configured") {
            setStatus("unavailable");
            setStatusMessage(res.message);
            return; // nothing to poll until someone sets it up; the page reload retries
          }
          if (first) {
            setStatus("error");
            setStatusMessage(res.message);
          }
          return;
        }
        const d = res.data;
        if (first) {
          first = false;
          setOpenedReadRow(d.lastReadRow);
          lastReadSent.current = d.lastReadRow;
          setStatus("ready");
        }
        cursor.current = Math.max(cursor.current, d.cursor);
        if (d.messages.length) {
          setMessages((prev) => {
            const have = new Set(prev.map((m) => m.messageId));
            const fresh = d.messages.filter((m) => !have.has(m.messageId));
            if (!fresh.length) return prev;
            // A message this member just sent is already on screen as a local bubble: the real row replaces it.
            const mine = fresh.filter((m) => m.memberId === me);
            const kept = prev.filter((m) => !(m.local === "sending" && mine.some((f) => f.kind === m.kind && f.text === m.text)));
            return [...kept, ...fresh].sort((a, b) => a.seq - b.seq);
          });
        }
        setCallsAvailable(d.callsAvailable);
        setActiveCall(d.call.active);
        if (inCall.current) setPollTick((t) => t + 1);
        if (d.call.signals.length) {
          const fresh = d.call.signals.filter((s) => !seenSignals.current.has(s.signalId));
          for (const s of fresh) seenSignals.current.add(s.signalId);
          if (fresh.length) onSignals.current?.(fresh);
        }
        if (d.call.cursor) signalCursorMs.current = Math.max(signalCursorMs.current, Date.parse(d.call.cursor) || 0);
        // The chat is open and visible: whatever has arrived counts as read.
        if (document.visibilityState === "visible") void markRead(d.cursor);
      } finally {
        polling.current = false;
        schedule();
      }
    };
    void pollRef.current();
    const onVisible = () => {
      if (document.visibilityState === "visible") void pollRef.current();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
    };
  }, [me, markRead, schedule]);

  const refresh = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    void pollRef.current();
  }, []);

  const deliver = useCallback(
    async (text: string, localId: string): Promise<boolean> => {
      const res = await apiRequest("/api/chat/messages", { method: "POST", body: JSON.stringify({ text }) });
      if (!res.ok) {
        setMessages((prev) => prev.map((m) => (m.messageId === localId ? { ...m, local: "failed" } : m)));
        return false;
      }
      refresh();
      return true;
    },
    [refresh],
  );

  const sendText = useCallback(
    async (text: string) => {
      const localId = `local_${++localCounter}`;
      setMessages((prev) => [...prev, { messageId: localId, memberId: me, kind: "text", text, createdAt: new Date().toISOString(), seq: Number.MAX_SAFE_INTEGER, local: "sending" }]);
      return deliver(text, localId);
    },
    [me, deliver],
  );

  const retry = useCallback(
    (localId: string) => {
      const target = messages.find((m) => m.messageId === localId);
      if (!target) return;
      setMessages((prev) => prev.map((m) => (m.messageId === localId ? { ...m, local: "sending" } : m)));
      void deliver(target.text, localId);
    },
    [messages, deliver],
  );

  const uploadFile = useCallback(
    async (file: File, kind: "file" | "voice", extra: { durationSec?: number; caption?: string } = {}) => {
      const form = new FormData();
      form.set("file", file);
      form.set("kind", kind);
      if (extra.durationSec) form.set("durationSec", String(Math.round(extra.durationSec)));
      if (extra.caption) form.set("caption", extra.caption);
      try {
        const res = await fetch("/api/chat/upload", { method: "POST", body: form });
        const body = await res.json().catch(() => null);
        if (!res.ok) return { ok: false as const, message: typeof body?.error?.message === "string" ? body.error.message : "The upload failed. Please try again." };
        refresh();
        return { ok: true as const };
      } catch {
        return { ok: false as const, message: "Network error. Check your connection and try again." };
      }
    },
    [refresh],
  );

  const setInCall = useCallback(
    (v: boolean) => {
      inCall.current = v;
      schedule(v ? 200 : undefined);
    },
    [schedule],
  );

  const setSignalHandler = useCallback((fn: ((signals: CallSignal[]) => void) | null) => {
    onSignals.current = fn;
  }, []);

  return { status, statusMessage, messages, openedReadRow, activeCall, pollTick, callsAvailable, sendText, retry, uploadFile, refresh, setSignalHandler, setInCall };
}
