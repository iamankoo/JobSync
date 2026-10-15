"use client";

import { useChatUnread } from "@/lib/chat/use-unread";

/** Unread-message pill next to "Group Chat" in the navigation. Hidden while the chat page is open. */
export function ChatUnreadBadge({ active }: { active: boolean }) {
  const unread = useChatUnread();
  if (active || unread <= 0) return null;
  return (
    <span
      data-testid="chat-unread-badge"
      aria-label={`${unread} unread message${unread === 1 ? "" : "s"}`}
      className="ml-auto grid min-w-6 place-items-center rounded-full bg-accent-strong px-2 py-0.5 text-xs font-bold text-on-accent"
    >
      {unread > 99 ? "99+" : unread}
    </span>
  );
}
