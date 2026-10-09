"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft, ArrowRight, BarChart3, Briefcase, Eye, EyeOff, Lock, ShieldCheck, Target, Trophy, Users,
  type LucideIcon,
} from "lucide-react";
import { MEMBERS, type Member } from "@/config/members";
import { Avatar } from "@/components/ui/avatar";
import { Logo } from "@/components/ui/logo";

const FLOATING: { label: string; Icon: LucideIcon; pos: string }[] = [
  { label: "More Opportunities", Icon: Briefcase, pos: "left-[3%] top-[9%] -rotate-[8deg]" },
  { label: "Track Applications", Icon: BarChart3, pos: "right-[3%] top-[8%] rotate-[8deg]" },
  { label: "Team Collaboration", Icon: Users, pos: "left-[3%] top-[34%] -rotate-[8deg]" },
  { label: "Achieve Your Goals", Icon: Target, pos: "right-[3%] top-[33%] rotate-[10deg]" },
];

const FEATURES: { title: string; text: string; Icon: LucideIcon }[] = [
  { title: "Private & Secure", text: "Only team members can access", Icon: ShieldCheck },
  { title: "Work Together", text: "Share opportunities", Icon: Users },
  { title: "Stay Consistent", text: "Track your progress", Icon: BarChart3 },
  { title: "Land Opportunities", text: "Achieve your goals", Icon: Trophy },
];

export function LoginScreen() {
  const router = useRouter();
  const [selected, setSelected] = useState<Member | null>(null);
  const [code, setCode] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);

  function choose(m: Member) {
    setSelected(m);
    setCode("");
    setError(null);
    setShow(false);
    setTimeout(() => codeRef.current?.focus(), 0);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberId: selected.id, code }),
      });
      if (res.ok) {
        router.replace("/dashboard");
        router.refresh();
        return;
      }
      if (res.status === 429) {
        const secs = Number(res.headers.get("Retry-After")) || 0;
        setError(`Too many attempts. Try again in ${Math.max(1, Math.ceil(secs / 60))} minute(s).`);
      } else if (res.status === 401) {
        setError("Incorrect access code. Please try again.");
      } else {
        setError("Something went wrong. Please try again.");
      }
      setCode("");
      codeRef.current?.focus();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-bg relative min-h-screen overflow-hidden">
      {FLOATING.map(({ label, Icon, pos }) => (
        <div
          key={label}
          aria-hidden
          className={`absolute hidden w-52 items-center gap-3 rounded-2xl border border-line bg-navy-800/60 p-4 text-sm text-ink/90 shadow-lg backdrop-blur xl:flex ${pos}`}
        >
          <Icon size={34} className="text-electric-soft" />
          <span className="max-w-[6rem] leading-tight">{label}</span>
        </div>
      ))}

      <main className="relative mx-auto flex min-h-screen max-w-4xl flex-col items-center px-4 pt-8 sm:pt-10">
        <Logo size="lg" />
        <h1 className="mt-3 text-xl font-semibold">Your Team&apos;s Job Hunt, Together</h1>
        <p className="mt-1 text-center text-muted">Add jobs. Track applications. Stay consistent. Land opportunities.</p>

        <h2 className="mt-8 text-center text-4xl font-bold sm:text-5xl">
          Select Your <span className="text-electric-soft">Name</span>
        </h2>
        <p className="mt-2 text-center text-muted">Click on your name to enter your access code and open your session</p>

        <ul className="mt-8 mx-auto grid w-full max-w-3xl grid-cols-3 gap-3 sm:gap-5" aria-label="Team members">
          {MEMBERS.map((m) => {
            const active = selected?.id === m.id;
            return (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => choose(m)}
                  aria-pressed={active}
                  className={`flex w-full flex-col items-center gap-2 rounded-xl border bg-navy-900/80 px-2 py-4 transition-all hover:-translate-y-0.5 hover:border-electric-soft sm:py-5 ${
                    active ? "border-electric shadow-[0_0_24px_rgba(47,107,255,0.45)]" : "border-line"
                  }`}
                >
                  <span className="sm:hidden"><Avatar member={m} size={64} /></span>
                  <span className="hidden sm:block"><Avatar member={m} size={124} /></span>
                  <span className="text-lg font-semibold sm:text-2xl">{m.name}</span>
                </button>
              </li>
            );
          })}
        </ul>

        {selected && (
          <form
            onSubmit={submit}
            aria-label={`Sign in as ${selected.name}`}
            className="relative mt-6 w-full max-w-2xl rounded-xl border border-line bg-navy-900/85 p-5 shadow-xl backdrop-blur sm:p-6"
          >
            <button
              type="button"
              onClick={() => { setSelected(null); setError(null); setCode(""); }}
              className="flex items-center gap-2 text-sm text-ink/90 hover:text-white"
            >
              <ArrowLeft size={18} aria-hidden /> Back
            </button>
            <div className="flex flex-col items-center text-center">
              <Avatar member={selected} size={72} />
              <p className="mt-1 text-2xl font-semibold">{selected.name}</p>
              <p className="text-sm text-muted">Enter your access code to open your session</p>
            </div>

            <label htmlFor="code" className="sr-only">Access code for {selected.name}</label>
            <div className="mt-5 flex items-center gap-3 rounded-lg border border-electric bg-navy-950/80 px-4 focus-within:ring-2 focus-within:ring-electric-soft">
              <Lock size={20} className="text-electric-soft" aria-hidden />
              <input
                id="code"
                ref={codeRef}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 4))}
                type={show ? "text" : "password"}
                inputMode="numeric"
                autoComplete="off"
                maxLength={4}
                placeholder="Enter 4-digit access code"
                aria-describedby={error ? "code-error" : undefined}
                aria-invalid={error ? true : undefined}
                className="h-12 w-full bg-transparent text-ink outline-none focus-visible:outline-none placeholder:text-muted"
              />
              <button
                type="button"
                onClick={() => setShow((s) => !s)}
                aria-label={show ? "Hide access code" : "Show access code"}
                className="rounded p-1 text-ink/80 hover:text-white"
              >
                {show ? <EyeOff size={20} aria-hidden /> : <Eye size={20} aria-hidden />}
              </button>
            </div>

            <p id="code-error" role="alert" className="mt-2 min-h-5 text-sm text-red-400">{error}</p>

            <button
              type="submit"
              disabled={busy || code.length === 0}
              className="mt-2 flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-electric font-semibold text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? "Checking…" : "Open Dashboard"} {!busy && <ArrowRight size={18} aria-hidden />}
            </button>
          </form>
        )}

        <ul className="mt-auto grid w-full grid-cols-2 gap-x-4 gap-y-5 border-t border-line py-8 pt-6 md:grid-cols-4">
          {FEATURES.map(({ title, text, Icon }) => (
            <li key={title} className="flex items-center gap-3">
              <Icon size={30} className="shrink-0 text-electric-soft" aria-hidden />
              <span>
                <span className="block text-sm font-semibold">{title}</span>
                <span className="block text-xs text-muted">{text}</span>
              </span>
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}
