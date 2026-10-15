"use client";

import { useLayoutEffect, useRef } from "react";
import { Loader2, Phone, Video } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { ErrorState } from "@/components/ui/empty-state";
import { getMember, MEMBERS, type MemberId } from "@/config/members";
import { useCall } from "@/lib/chat/use-call";
import { useChat } from "@/lib/chat/use-chat";
import { CallBanner, CallErrorNotice, CallPanel } from "./call-panel";
import { Composer } from "./composer";
import { MessageList } from "./message-list";

/**
 * Sizes the chat to exactly the space left below the app header, so the page itself never scrolls (only the message
 * list does) at any phone, tablet or desktop size, including when the header wraps or a mobile keyboard opens.
 */
function useFillViewport(ref: React.RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      const viewport = window.visualViewport?.height ?? window.innerHeight;
      const top = el.getBoundingClientRect().top + window.scrollY;
      const pad = parseFloat(getComputedStyle(el.parentElement ?? el).paddingBottom) || 0;
      el.style.height = `${Math.max(340, Math.floor(viewport - top - pad))}px`;
    };
    fit();
    window.addEventListener("resize", fit);
    window.visualViewport?.addEventListener("resize", fit);
    // The app header can change height after hydration, fonts or the search box lay out: follow it.
    const ro = new ResizeObserver(fit);
    ro.observe(document.body);
    const header = document.querySelector("body header");
    if (header) ro.observe(header);
    const settle = [100, 400, 1200].map((ms) => window.setTimeout(fit, ms));
    return () => {
      window.removeEventListener("resize", fit);
      window.visualViewport?.removeEventListener("resize", fit);
      ro.disconnect();
      settle.forEach(clearTimeout);
    };
  }, [ref]);
}

/** The private Anni / Lukky / Rishii chat: messages, files, voice notes and audio/video calls. */
export function ChatView({ me }: { me: MemberId }) {
  const root = useRef<HTMLElement>(null);
  useFillViewport(root);
  const chat = useChat(me);
  const call = useCall(me, chat);
  const member = getMember(me)!;
  const inCall = call.phase !== "idle";
  const canCall = chat.status === "ready" && chat.callsAvailable;
  const callLive = chat.activeCall !== null;

  if (chat.status === "unavailable") {
    return (
      <div className="space-y-5">
        <h1 className="text-3xl font-bold">Group Chat</h1>
        <ErrorState title="Group Chat isn't set up yet" message={chat.statusMessage} />
      </div>
    );
  }

  return (
    <section ref={root} aria-label="Group chat" className="flex h-[calc(100dvh-11rem)] min-h-[340px] flex-col overflow-hidden rounded-2xl border border-line bg-navy-900 lg:h-[calc(100dvh-8.5rem)]">
      <div className="flex items-center gap-3 border-b border-line px-3 py-2.5 sm:px-5">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-bold leading-tight sm:text-xl">Group Chat</h1>
          <ul className="mt-1 flex items-center gap-1.5" aria-label="Members">
            {MEMBERS.map((m) => (
              <li key={m.id} className="flex items-center gap-1.5 text-xs text-muted" title={m.name}>
                <Avatar member={m} size={20} ring={m.id === member.id} />
                <span className={m.id === me ? "font-semibold" : "hidden sm:inline"} style={{ color: m.id === me ? m.accentText : undefined }}>
                  {m.id === me ? "You" : m.name}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => void call.start("audio")}
            disabled={!canCall || inCall || callLive}
            aria-label="Start an audio call"
            title={callLive ? "A call is already running: join it from the banner" : "Start an audio call"}
            className="inline-flex h-11 items-center gap-2 rounded-lg border border-line px-3 text-sm font-semibold transition hover:border-electric-soft disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Phone size={18} aria-hidden />
            <span className="hidden md:inline">Audio call</span>
          </button>
          <button
            type="button"
            onClick={() => void call.start("video")}
            disabled={!canCall || inCall || callLive}
            aria-label="Start a video call"
            title={callLive ? "A call is already running: join it from the banner" : "Start a video call"}
            className="inline-flex h-11 items-center gap-2 rounded-lg border border-line px-3 text-sm font-semibold transition hover:border-electric-soft disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Video size={18} aria-hidden />
            <span className="hidden md:inline">Video call</span>
          </button>
        </div>
      </div>

      {call.error && <CallErrorNotice error={call.error} onDismiss={call.clearError} />}
      {!call.error && call.endedNotice && !inCall && <CallErrorNotice error={{ title: "Call ended", message: call.endedNotice }} onDismiss={call.clearError} />}
      {inCall ? (
        <CallPanel me={me} call={call} />
      ) : (
        chat.activeCall && <CallBanner call={chat.activeCall} me={me} disabled={inCall} onJoin={(withVideo) => void call.join(chat.activeCall!, withVideo)} />
      )}

      {chat.status === "loading" ? (
        <div role="status" className="grid flex-1 place-items-center text-muted">
          <span className="flex items-center gap-2">
            <Loader2 className="animate-spin" size={18} aria-hidden /> Loading messages…
          </span>
        </div>
      ) : chat.status === "error" ? (
        <div className="grid flex-1 place-items-center p-4">
          <ErrorState title="Can't load the chat" message={chat.statusMessage || "Please try again in a moment."} />
        </div>
      ) : (
        <MessageList me={me} messages={chat.messages} openedReadRow={chat.openedReadRow} onRetry={chat.retry} />
      )}

      <Composer chat={chat} disabled={chat.status !== "ready"} />
    </section>
  );
}
