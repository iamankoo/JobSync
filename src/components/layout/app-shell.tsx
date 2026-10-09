"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { LogOut, Menu, X } from "lucide-react";
import type { Member } from "@/config/members";
import { Avatar } from "@/components/ui/avatar";
import { Logo } from "@/components/ui/logo";
import { Sidebar } from "./sidebar";

export function AppShell({ member, children }: { member: Member; children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  async function logout() {
    setBusy(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      router.replace("/login");
      router.refresh();
    }
  }

  return (
    <div data-member={member.id} className="min-h-screen bg-navy-950">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-electric focus:px-3 focus:py-2">
        Skip to content
      </a>

      <aside className="fixed inset-y-0 left-0 z-30 hidden w-72 border-r border-line bg-navy-950 lg:block">
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
        <header className="sticky top-0 z-20 flex h-16 items-center justify-between gap-3 border-b border-line bg-navy-950/90 px-4 backdrop-blur sm:px-6">
          <div className="flex items-center gap-3 lg:hidden">
            <button className="rounded-lg border border-line p-2" aria-label="Open menu" aria-expanded={open} onClick={() => setOpen(true)}>
              <Menu size={20} aria-hidden />
            </button>
            <Logo />
          </div>
          <div className="ml-auto flex items-center gap-3">
            <div className="flex items-center gap-2">
              <Avatar member={member} size={36} ring />
              <span className="hidden text-sm font-semibold sm:block" style={{ color: member.accentText }}>
                {member.name}
              </span>
            </div>
            <button
              onClick={logout}
              disabled={busy}
              className="flex items-center gap-2 whitespace-nowrap rounded-lg border border-line px-3 py-2 text-sm font-medium text-muted transition-colors hover:border-accent hover:text-ink disabled:opacity-60"
            >
              <LogOut size={16} aria-hidden />
              Log out
            </button>
          </div>
        </header>
        <main id="main" key={pathname} className="p-4 sm:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
