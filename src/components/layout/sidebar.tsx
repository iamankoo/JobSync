"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, Briefcase, Home, PlusCircle, Send, type LucideIcon } from "lucide-react";
import { NAV_ITEMS } from "@/config/nav";
import { MEMBERS, type Member } from "@/config/members";
import { Avatar } from "@/components/ui/avatar";
import { Logo } from "@/components/ui/logo";

const ICONS: Record<string, LucideIcon> = {
  "/dashboard": Home,
  "/all-jobs": Briefcase,
  "/add-job": PlusCircle,
  "/my-applications": Send,
  "/analytics": BarChart3,
};

export function Sidebar({ current, onNavigate }: { current: Member; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <div className="flex h-full flex-col gap-6 p-4">
      <div className="px-2 pt-1">
        <Logo tagline />
      </div>
      <nav aria-label="Main" className="flex flex-col gap-1.5">
        {NAV_ITEMS.map((item) => {
          const Icon = ICONS[item.href];
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={`flex items-center gap-4 rounded-lg px-4 py-3 text-base font-medium transition-colors ${
                active ? "bg-electric text-white" : "text-ink/90 hover:bg-navy-700"
              }`}
            >
              <Icon size={22} aria-hidden />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <section aria-label="Team members" className="mt-auto rounded-xl border border-line bg-navy-900 p-3">
        <h2 className="mb-3 text-sm font-semibold">Team Members</h2>
        <ul className="flex justify-between">
          {MEMBERS.map((m) => (
            <li key={m.id} className="flex flex-col items-center gap-1 text-sm" style={{ color: m.id === current.id ? m.accentText : undefined }}>
              <Avatar member={m} size={48} ring={m.id === current.id} />
              <span className="font-medium">{m.name}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
