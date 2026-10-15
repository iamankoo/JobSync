"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Mic, Paperclip, Send, Square, X } from "lucide-react";
import { ACCEPTED_EXTENSIONS, MAX_VOICE_SECONDS, validateUpload } from "@/lib/chat/files";
import { describeMediaError } from "@/lib/chat/use-call";
import type { UseChat } from "@/lib/chat/use-chat";

const MIME_CHOICES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

type Recorder = { mr: MediaRecorder; stream: MediaStream; chunks: Blob[]; startedAt: number; mime: string; cancelled: boolean };

export function Composer({ chat, disabled }: { chat: Pick<UseChat, "sendText" | "uploadFile">; disabled: boolean }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [recording, setRecording] = useState<{ seconds: number } | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const rec = useRef<Recorder | null>(null);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);

  // Grow with the content (1 to 5 lines).
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [text]);

  const send = useCallback(async () => {
    const value = text.trim();
    if (!value || disabled) return;
    setText("");
    setProblem(null);
    await chat.sendText(value);
    area.current?.focus();
  }, [chat, text, disabled]);

  async function pickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || disabled) return;
    setProblem(null);
    // Same rules as the server (the server still re-checks the real bytes).
    const bytes = new Uint8Array(await file.arrayBuffer());
    const checked = validateUpload(bytes, file.name, "file");
    if (!checked.ok) return setProblem(`${file.name}: ${checked.problem.message}`);
    setBusy(`Uploading ${file.name}…`);
    const res = await chat.uploadFile(file, "file");
    setBusy(null);
    if (!res.ok) setProblem(`${file.name}: ${res.message}`);
  }

  async function startRecording() {
    if (rec.current || disabled) return;
    setProblem(null);
    if (typeof MediaRecorder === "undefined") return setProblem("Voice notes aren't supported in this browser.");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      return setProblem(`${describeMediaError(err, false).title}. ${describeMediaError(err, false).message}`);
    }
    const mime = MIME_CHOICES.find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
    const mr = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    const r: Recorder = { mr, stream, chunks: [], startedAt: Date.now(), mime: mr.mimeType || mime, cancelled: false };
    mr.ondataavailable = (e) => e.data.size && r.chunks.push(e.data);
    mr.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      if (tick.current) clearInterval(tick.current);
      tick.current = null;
      rec.current = null;
      setRecording(null);
      if (r.cancelled || r.chunks.length === 0) return;
      const seconds = Math.max(1, Math.round((Date.now() - r.startedAt) / 1000));
      const blob = new Blob(r.chunks, { type: r.mime });
      const ext = r.mime.includes("mp4") ? "m4a" : r.mime.includes("ogg") ? "ogg" : "webm";
      setBusy("Sending voice note…");
      const res = await chat.uploadFile(new File([blob], `voice-note.${ext}`, { type: r.mime }), "voice", { durationSec: seconds });
      setBusy(null);
      if (!res.ok) setProblem(`Voice note: ${res.message}`);
    };
    rec.current = r;
    mr.start(250);
    setRecording({ seconds: 0 });
    tick.current = setInterval(() => {
      const s = Math.round((Date.now() - r.startedAt) / 1000);
      setRecording({ seconds: s });
      if (s >= MAX_VOICE_SECONDS && mr.state !== "inactive") mr.stop();
    }, 500);
  }

  function stopRecording(cancel: boolean) {
    const r = rec.current;
    if (!r) return;
    r.cancelled = cancel;
    if (r.mr.state !== "inactive") r.mr.stop();
  }

  useEffect(
    () => () => {
      // Leaving the page discards an unfinished recording and releases the microphone.
      if (rec.current) {
        rec.current.cancelled = true;
        if (rec.current.mr.state !== "inactive") rec.current.mr.stop();
        rec.current.stream.getTracks().forEach((t) => t.stop());
      }
      if (tick.current) clearInterval(tick.current);
    },
    [],
  );

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends on desktop keyboards; Shift+Enter (or the on-screen keyboard's Enter on touch devices) adds a line.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia("(pointer: fine)").matches) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <div className="border-t border-line bg-navy-900 p-2.5 sm:p-3">
      {problem && (
        <p role="alert" className="mb-2 flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-100">
          <span className="flex-1">{problem}</span>
          <button type="button" onClick={() => setProblem(null)} aria-label="Dismiss" className="rounded p-0.5 opacity-80 hover:opacity-100">
            <X size={16} aria-hidden />
          </button>
        </p>
      )}
      {busy && (
        <p role="status" className="mb-2 flex items-center gap-2 text-sm text-muted">
          <Loader2 size={16} className="animate-spin" aria-hidden /> {busy}
        </p>
      )}
      {recording ? (
        <div className="flex items-center gap-3" data-testid="recording-bar">
          <span aria-hidden className="h-3 w-3 animate-pulse rounded-full bg-red-500" />
          <p className="flex-1 text-sm font-medium" role="status">
            Recording… <span className="tabular-nums">{clock(recording.seconds)}</span> <span className="text-muted">/ {clock(MAX_VOICE_SECONDS)}</span>
          </p>
          <button type="button" onClick={() => stopRecording(true)} aria-label="Cancel recording" className="grid h-11 w-11 place-items-center rounded-full border border-line text-muted hover:text-ink">
            <X size={20} aria-hidden />
          </button>
          <button type="button" onClick={() => stopRecording(false)} aria-label="Stop and send voice note" className="grid h-11 w-11 place-items-center rounded-full bg-accent-strong text-on-accent">
            <Square size={18} aria-hidden />
          </button>
        </div>
      ) : (
        <div className="flex items-end gap-2">
          <input ref={picker} type="file" hidden onChange={pickFile} accept={ACCEPTED_EXTENSIONS.map((e) => `.${e}`).join(",")} data-testid="chat-file-input" />
          <button type="button" onClick={() => picker.current?.click()} disabled={disabled || !!busy} aria-label="Attach a file, image or PDF" className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-line text-muted transition hover:border-electric-soft hover:text-ink disabled:opacity-50">
            <Paperclip size={20} aria-hidden />
          </button>
          <label className="min-w-0 flex-1">
            <span className="sr-only">Message</span>
            <textarea
              ref={area}
              value={text}
              rows={1}
              maxLength={4000}
              disabled={disabled}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKey}
              placeholder="Write a message…"
              className="block max-h-[132px] min-h-11 w-full resize-none rounded-2xl border border-line bg-navy-950/60 px-4 py-2.5 text-[0.95rem] text-ink outline-none placeholder:text-muted focus-visible:border-electric-soft disabled:opacity-60"
            />
          </label>
          {text.trim() ? (
            <button type="button" onClick={() => void send()} disabled={disabled} aria-label="Send message" className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-accent-strong text-on-accent transition hover:brightness-110 disabled:opacity-50">
              <Send size={19} aria-hidden />
            </button>
          ) : (
            <button type="button" onClick={() => void startRecording()} disabled={disabled || !!busy} aria-label="Record a voice note" className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-accent-strong text-on-accent transition hover:brightness-110 disabled:opacity-50">
              <Mic size={19} aria-hidden />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
