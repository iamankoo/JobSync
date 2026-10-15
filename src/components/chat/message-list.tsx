"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ArrowDown, Download, ExternalLink, FileText, Loader2, Phone, RotateCw } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { getMember, type MemberId } from "@/config/members";
import { formatBytes } from "@/lib/chat/files";
import type { ClientMessage } from "@/lib/chat/types";

const GROUP_GAP_MS = 5 * 60_000;

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

/** Text with http(s) links made clickable. Everything else stays plain text (React escapes it). */
function Linkified({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s<>"']+)/g);
  return (
    <>
      {parts.map((p, i) =>
        /^https?:\/\//.test(p) ? (
          <a key={i} href={p} target="_blank" rel="noopener noreferrer" className="underline decoration-1 underline-offset-2 hover:opacity-80">
            {p}
          </a>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

const fileUrl = (id: string) => `/api/chat/files/${encodeURIComponent(id)}`;

function Attachment({ m, mine }: { m: ClientMessage; mine: boolean }) {
  if (!m.fileId) return null;
  const url = fileUrl(m.fileId);
  const mime = m.mimeType ?? "";
  if (m.kind === "voice" || mime.startsWith("audio/")) {
    return (
      <div className="min-w-0">
        <audio controls preload="none" src={url} className="h-10 w-full max-w-[17rem]" aria-label={`Voice note from ${getMember(m.memberId)?.name ?? "member"}`} />
        {m.durationSec ? <p className="mt-1 text-xs opacity-80">{Math.floor(m.durationSec / 60)}:{String(m.durationSec % 60).padStart(2, "0")}</p> : null}
      </div>
    );
  }
  if (/^image\/(png|jpeg|gif|webp)$/.test(mime)) {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" className="block overflow-hidden rounded-lg">
        {/* eslint-disable-next-line @next/next/no-img-element -- authorised, same-origin, user-uploaded bytes */}
        <img src={url} alt={m.fileName ?? "Shared image"} loading="lazy" className="max-h-72 w-auto max-w-full rounded-lg object-contain" />
      </a>
    );
  }
  const isPdf = mime === "application/pdf";
  return (
    <div className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${mine ? "border-white/25 bg-black/10" : "border-line bg-navy-950/60"}`}>
      <FileText size={26} aria-hidden className="shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold" title={m.fileName}>{m.fileName ?? "File"}</p>
        <p className="text-xs opacity-80">{isPdf ? "PDF · " : ""}{m.sizeBytes ? formatBytes(m.sizeBytes) : ""}</p>
      </div>
      {isPdf && (
        <a href={url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${m.fileName ?? "PDF"}`} className="rounded-md p-1.5 hover:bg-white/10">
          <ExternalLink size={18} aria-hidden />
        </a>
      )}
      <a href={url} download={m.fileName ?? true} aria-label={`Download ${m.fileName ?? "file"}`} className="rounded-md p-1.5 hover:bg-white/10">
        <Download size={18} aria-hidden />
      </a>
    </div>
  );
}

interface Props {
  me: MemberId;
  messages: ClientMessage[];
  /** Messages with a row above this and not sent by me were new when the chat was opened. */
  openedReadRow: number;
  /** Each member's read position, to show who has seen what. */
  readers: Partial<Record<MemberId, number>>;
  onRetry: (localId: string) => void;
}

export function MessageList({ me, messages, openedReadRow, readers, onRetry }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const prevCount = useRef(0);
  const [away, setAway] = useState(0);

  const firstUnreadSeq = useMemo(() => messages.find((m) => !m.local && m.seq > openedReadRow && m.memberId !== me)?.seq ?? null, [messages, me, openedReadRow]);

  // "Seen by": a member's avatar sits under the latest message from someone else that they have read (like LinkedIn).
  const seenBy = useMemo(() => {
    const out = new Map<string, MemberId[]>();
    for (const viewer of Object.keys(readers) as MemberId[]) {
      if (viewer === me) continue;
      const upTo = readers[viewer] ?? 0;
      const last = [...messages].reverse().find((m) => !m.local && m.kind !== "call" && m.memberId !== viewer && m.seq <= upTo);
      if (last) out.set(last.messageId, [...(out.get(last.messageId) ?? []), viewer]);
    }
    return out;
  }, [messages, readers, me]);

  function scrollToEnd(smooth = false) {
    const el = box.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }

  // Keep the newest message in view unless the reader has scrolled up to read history.
  useLayoutEffect(() => {
    const added = messages.length - prevCount.current;
    const last = messages[messages.length - 1];
    if (prevCount.current === 0 || stuck.current || last?.memberId === me) {
      scrollToEnd();
      stuck.current = true;
      setAway(0);
    } else if (added > 0) setAway((n) => n + added);
    prevCount.current = messages.length;
  }, [messages, me]);

  // Images and the like change the height after the first paint.
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => stuck.current && scrollToEnd());
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => ro.disconnect();
  }, [messages.length]);

  function onScroll() {
    const el = box.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stuck.current = near;
    if (near) setAway(0);
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={box} onScroll={onScroll} role="log" aria-live="polite" aria-label="Chat messages" tabIndex={0} className="h-full overflow-y-auto overscroll-contain px-3 py-4 sm:px-5">
        {messages.length === 0 && (
          <div className="grid h-full place-items-center text-center">
            <div className="max-w-xs">
              <p className="text-lg font-semibold">No messages yet</p>
              <p className="mt-1 text-sm text-muted">Say hello to Anni, Lukky and Rishii. Messages, files, voice notes and calls stay private to the three of you.</p>
            </div>
          </div>
        )}
        <ul className="flex flex-col gap-1">
          {messages.map((m, i) => {
            const prev = messages[i - 1];
            const mine = m.memberId === me;
            const member = getMember(m.memberId);
            const newDay = !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
            const grouped = !!prev && !newDay && prev.kind !== "call" && m.kind !== "call" && prev.memberId === m.memberId && Date.parse(m.createdAt) - Date.parse(prev.createdAt) < GROUP_GAP_MS && m.seq !== firstUnreadSeq;
            return (
              <li key={m.messageId} className="list-none">
                {newDay && (
                  <div className="my-3 flex justify-center">
                    <span className="rounded-full bg-navy-800 px-3 py-1 text-xs font-medium text-muted">{dayLabel(m.createdAt)}</span>
                  </div>
                )}
                {m.seq === firstUnreadSeq && (
                  <div role="separator" aria-label="New messages" data-testid="unread-divider" className="my-3 flex items-center gap-3 text-xs font-semibold text-accent">
                    <span className="h-px flex-1 bg-current opacity-40" />
                    New messages
                    <span className="h-px flex-1 bg-current opacity-40" />
                  </div>
                )}
                {m.kind === "call" ? (
                  <p className="my-2 flex items-center justify-center gap-2 text-center text-xs text-muted" data-testid="call-event">
                    <Phone size={13} aria-hidden /> {m.text} · {timeOf(m.createdAt)}
                  </p>
                ) : (
                  <div className={`flex items-end gap-2 ${mine ? "flex-row-reverse" : ""} ${grouped ? "mt-px" : "mt-2.5"}`} data-testid="chat-message" data-sender={m.memberId}>
                    <span className={`w-8 shrink-0 ${grouped ? "invisible" : ""}`} aria-hidden>
                      {member && !grouped && <Avatar member={member} size={32} />}
                    </span>
                    <div className={`flex min-w-0 max-w-[85%] flex-col sm:max-w-[75%] ${mine ? "items-end" : "items-start"}`}>
                      {!grouped && (
                        <p className="mb-0.5 px-1 text-xs font-semibold" style={{ color: member?.accentText }}>
                          {mine ? "You" : member?.name}
                        </p>
                      )}
                      <div
                        data-bubble
                        className={`min-w-0 max-w-full rounded-[1.15rem] px-4 pb-2 pt-2.5 text-base leading-snug shadow-sm ${
                          mine
                            ? `bg-accent-strong text-on-accent ${grouped ? "rounded-tr-md" : ""} rounded-br-md`
                            : `border border-line bg-navy-800 text-ink ${grouped ? "rounded-tl-md" : ""} rounded-bl-md`
                        } ${m.local === "failed" ? "opacity-70 ring-1 ring-red-400" : ""}`}
                      >
                        {m.fileId && <Attachment m={m} mine={mine} />}
                        {m.text ? (
                          <p className={`whitespace-pre-wrap break-words [overflow-wrap:anywhere] ${m.fileId ? "mt-2" : ""}`}>
                            <Linkified text={m.text} />
                            {/* The time lives inside the bubble, floated to the bottom-right of the last line (like WhatsApp). */}
                            <span className="float-right ml-3 mt-2 translate-y-1 select-none text-[0.68rem] font-medium leading-none tabular-nums opacity-70">
                              <time dateTime={m.createdAt}>{timeOf(m.createdAt)}</time>
                            </span>
                          </p>
                        ) : (
                          <p className="mt-1 text-right text-[0.68rem] font-medium leading-none tabular-nums opacity-70">
                            <time dateTime={m.createdAt}>{timeOf(m.createdAt)}</time>
                          </p>
                        )}
                      </div>
                      {m.local === "sending" && (
                        <p className="mt-0.5 flex items-center gap-1.5 px-1 text-[0.7rem] text-muted">
                          <Loader2 size={11} className="animate-spin" aria-hidden /> Sending…
                        </p>
                      )}
                      {m.local === "failed" && (
                        <p className="mt-0.5 flex items-center gap-1.5 px-1 text-[0.7rem] text-muted">
                          <AlertCircle size={11} className="text-red-300" aria-hidden /> Not sent
                          <button type="button" onClick={() => onRetry(m.messageId)} className="inline-flex items-center gap-1 rounded px-1 font-semibold text-ink underline">
                            <RotateCw size={11} aria-hidden /> Retry
                          </button>
                        </p>
                      )}
                      {(seenBy.get(m.messageId) ?? []).length > 0 && (
                        <ul className="mt-1 flex items-center -space-x-1 px-1" data-testid="seen-by" aria-label={`Seen by ${(seenBy.get(m.messageId) ?? []).map((v) => getMember(v)?.name).join(" and ")}`}>
                          {(seenBy.get(m.messageId) ?? []).map((v) => {
                            const viewer = getMember(v);
                            return viewer ? (
                              <li key={v} data-viewer={v} title={`Seen by ${viewer.name}`} className="list-none rounded-full ring-2 ring-navy-900">
                                <Avatar member={viewer} size={18} />
                              </li>
                            ) : null;
                          })}
                        </ul>
                      )}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
      {away > 0 && (
        <button
          type="button"
          onClick={() => {
            stuck.current = true;
            scrollToEnd(true);
            setAway(0);
          }}
          className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full bg-accent-strong px-4 py-2 text-sm font-semibold text-on-accent shadow-lg"
        >
          <ArrowDown size={16} aria-hidden /> {away} new message{away === 1 ? "" : "s"}
        </button>
      )}
    </div>
  );
}
