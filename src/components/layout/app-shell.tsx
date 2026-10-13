"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { LogOut, Menu, Search, X } from "lucide-react";
import type { Member } from "@/config/members";
import { Avatar } from "@/components/ui/avatar";
import { Logo } from "@/components/ui/logo";
import { FollowUpGate, type DueFollowUpItem } from "@/components/follow-up/follow-up-gate";
import { NotificationManager } from "@/components/notifications/notification-manager";
import { removeThisDevice } from "@/lib/push/browser";
import { AutoRefresh } from "./auto-refresh";
import { Sidebar } from "./sidebar";

export function AppShell({
  member,
  children,
  followUps = [],
  timeZone = "UTC",
}: {
  member: Member;
  children: React.ReactNode;
  /** Follow-up questions due for this member, decided on the server. */
  followUps?: DueFollowUpItem[];
  timeZone?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  // Ctrl/Cmd + K focuses the search box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function search(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    router.push(q ? `/all-jobs?q=${encodeURIComponent(q)}` : "/all-jobs");
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  async function logout() {
    setBusy(true);
    try {
      // Detach this browser from the member before the session ends (other devices keep their notifications).
      await removeThisDevice();
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      router.replace("/login");
      router.refresh();
    }
  }

  return (
    <div data-member={member.id} className="min-h-screen bg-navy-950">
      <AutoRefresh />
      <FollowUpGate items={followUps} timeZone={timeZone} />
      <NotificationManager memberId={member.id} showOnboarding={pathname === "/dashboard" && followUps.length === 0} />
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-electric focus:px-3 focus:py-2">
        Skip to content
      </a>

      <aside aria-label="Sidebar" className="fixed inset-y-0 left-0 z-30 hidden w-72 border-r border-line bg-navy-950 lg:block">
        <Sidebar current={member} />
      </aside>

      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation menu">
          <button className="absolute inset-0 bg-black/60" aria-label="Close menu" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-72 max-w-[85vw] overflow-y-auto border-r border-line bg-navy-950">
            <button className="absolute right-3 top-3 rounded p-1 text-muted hover:text-ink" aria-label="Close menu" onClick={() => setOpen(false)}>
              <X size={22} aria-hidden />
            </button>
            <Sidebar current={member} onNavigate={() => setOpen(false)} />
          </div>
        </div>
      )}

      <div className="lg:pl-72">
        <header className="sticky top-0 z-20 flex flex-wrap items-center gap-3 border-b border-line bg-navy-950/90 px-4 py-3 backdrop-blur sm:px-6">
          <div className="flex items-center gap-3 lg:hidden">
            <button className="rounded-lg border border-line p-2" aria-label="Open menu" aria-expanded={open} onClick={() => setOpen(true)}>
              <Menu size={20} aria-hidden />
            </button>
            <Logo />
          </div>
          <form role="search" onSubmit={search} className="relative order-3 w-full lg:order-none lg:max-w-2xl lg:flex-1">
            <label htmlFor="global-search" className="sr-only">Search jobs by title, company, location or keyword</label>
            <Search size={18} aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" />
            <input
              id="global-search"
              ref={searchRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search jobs, companies, locations…"
              className="h-11 w-full rounded-lg border border-line bg-navy-900 pl-10 pr-16 text-sm text-ink outline-none placeholder:text-muted hover:border-electric-soft focus-visible:border-electric-soft"
            />
            <kbd aria-hidden className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 rounded border border-line bg-navy-800 px-1.5 py-0.5 text-xs text-muted sm:block">
              Ctrl + K
            </kbd>
          </form>
          {/* Pinned to the top-right: Log out sits just left of the account, which is the far-right item. */}
          <div className="ml-auto flex shrink-0 items-center gap-3">
            <button
              onClick={logout}
              disabled={busy}
              className="flex items-center gap-2 whitespace-nowrap rounded-lg border border-line px-3 py-2 text-sm font-medium text-muted transition-colors hover:border-accent hover:text-ink disabled:opacity-60"
            >
              <LogOut size={16} aria-hidden />
              Log out
            </button>
            <div className="flex items-center gap-2">
              <Avatar member={member} size={36} ring />
              <span className="hidden text-sm font-semibold sm:block" style={{ color: member.accentText }}>
                {member.name}
              </span>
            </div>
          </div>
        </header>
        <main id="main" key={pathname} className="p-4 sm:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
