"use client";

import { useLayoutEffect, useRef } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2, Phone, Video } from "lucide-react";
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
    const phone = window.matchMedia("(max-width: 1023px)");
    const vv = window.visualViewport;
    const fit = () => {
      const viewport = vv?.height ?? window.innerHeight;
      if (phone.matches) {
        // Phones and tablets: the chat IS the screen. It is pinned to the visible area, so when the on-screen keyboard
        // opens only the chat shrinks (the composer rides above the keyboard) and the page never shifts.
        Object.assign(el.style, { position: "fixed", left: "0", right: "0", top: `${vv?.offsetTop ?? 0}px`, height: `${Math.floor(viewport)}px`, zIndex: "20" });
        if (window.scrollY !== 0) window.scrollTo(0, 0);
        return;
      }
      Object.assign(el.style, { position: "", left: "", right: "", top: "", zIndex: "" });
      const top = el.getBoundingClientRect().top + window.scrollY;
      const pad = parseFloat(getComputedStyle(el.parentElement ?? el).paddingBottom) || 0;
      el.style.height = `${Math.max(340, Math.floor(viewport - top - pad))}px`;
    };
    // While the chat is the whole screen on a phone the page behind must not scroll or bounce.
    const lock = () => {
      document.documentElement.style.overflow = phone.matches ? "hidden" : "";
      document.body.style.overflow = phone.matches ? "hidden" : "";
    };
    const refit = () => {
      lock();
      fit();
    };
    refit();
    window.addEventListener("resize", refit);
    window.addEventListener("scroll", fit);
    vv?.addEventListener("resize", fit);
    vv?.addEventListener("scroll", fit);
    phone.addEventListener("change", refit);
    // The app header can change height after hydration, fonts or the search box lay out: follow it.
    const ro = new ResizeObserver(fit);
    ro.observe(document.body);
    const header = document.querySelector("body header");
    if (header) ro.observe(header);
    const settle = [100, 400, 1200].map((ms) => window.setTimeout(fit, ms));
    return () => {
      window.removeEventListener("resize", refit);
      window.removeEventListener("scroll", fit);
      vv?.removeEventListener("resize", fit);
      vv?.removeEventListener("scroll", fit);
      phone.removeEventListener("change", refit);
      ro.disconnect();
      settle.forEach(clearTimeout);
      document.documentElement.style.overflow = "";
      document.body.style.overflow = "";
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
    <section ref={root} aria-label="Group chat" className="flex h-[calc(100dvh-11rem)] min-h-[340px] flex-col overflow-hidden rounded-2xl border border-line bg-navy-900 max-lg:rounded-none max-lg:border-0 lg:h-[calc(100dvh-8.5rem)]">
      <div className="flex items-center gap-3 border-b border-line px-3 py-2.5 sm:px-5">
        {/* On phones and tablets the app header is hidden in the chat, so this is the way back. */}
        <Link href="/dashboard" aria-label="Back to JobSync" className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-line text-muted hover:text-ink lg:hidden">
          <ArrowLeft size={20} aria-hidden />
        </Link>
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
        <MessageList me={me} messages={chat.messages} openedReadRow={chat.openedReadRow} readers={chat.readers} onRetry={chat.retry} />
      )}

      <Composer chat={chat} disabled={chat.status !== "ready"} />
    </section>
  );
}
