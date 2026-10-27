"use client";

import { useId, useState } from "react";
import { Lock } from "lucide-react";
import type { Member } from "@/config/members";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/client/api";
import type { UnlockedProfile } from "@/lib/profile/unlocked";
import { LogoutSection } from "./logout-section";
import { ProfileForm } from "./profile-form";

type Screen = "set" | "unlock" | "recover";
const input = "h-11 w-full rounded-lg border border-line bg-navy-950/60 px-3 text-sm text-ink outline-none transition placeholder:text-muted focus-visible:border-electric-soft";

/**
 * Profile Lock. Every visit starts locked: the page itself carries no profile data; it arrives only in the
 * response to a correct password (or, for Anni, his recovery answer).
 */
export function ProfileGate({ member, hasPassword, isAdmin, timeZone }: { member: Member; hasPassword: boolean; isAdmin: boolean; timeZone: string }) {
  const uid = useId();
  const [screen, setScreen] = useState<Screen>(hasPassword ? "unlock" : "set");
  const [data, setData] = useState<UnlockedProfile | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showReset, setShowReset] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setShowReset(false);
    if (screen === "set" && password !== confirm) {
      // Nothing is sent or saved until both entries match.
      setConfirm("");
      return setError("Passwords do not match. Please try again.");
    }
    setBusy(true);
    const res =
      screen === "set"
        ? await apiRequest<UnlockedProfile>("/api/profile/password", { method: "POST", body: JSON.stringify({ password, confirm }) })
        : screen === "unlock"
          ? await apiRequest<UnlockedProfile>("/api/profile/unlock", { method: "POST", body: JSON.stringify({ password }) })
          : await apiRequest<UnlockedProfile>("/api/profile/recover", { method: "POST", body: JSON.stringify({ answer }) });
    setBusy(false);
    setPassword("");
    setConfirm("");
    setAnswer("");
    if (res.ok) return setData(res.data);
    if (res.code === "password_mismatch") return setError("Passwords do not match. Please try again.");
    if (res.code === "password_not_set") return setScreen("set");
    if (res.code === "password_exists") return setScreen("unlock");
    setError(res.message);
  }

  /** Called when the admin resets his own password while unlocked: back to first-time setup. */
  function relock() {
    setData(null);
    setScreen("set");
    setError(null);
  }

  if (data) {
    return (
      <div className="mx-auto w-full max-w-2xl space-y-5" data-testid="profile-content">
        <ProfileForm member={member} profile={data.profile} resumes={data.resumes} photos={data.photos} gmail={data.gmail} isAdmin={isAdmin} onSelfReset={relock} timeZone={timeZone} />
        <LogoutSection member={member} />
      </div>
    );
  }

  const title = screen === "set" ? "Set Profile Password" : screen === "recover" ? "Another way to unlock" : "Profile Password";
  return (
    // Centred in the main content area (the header and page padding take about 9rem of the viewport height).
    <div className="flex min-h-[calc(100dvh-9rem)] w-full items-center justify-center">
    <div className="w-full max-w-md space-y-5" data-testid="profile-lock">
      <div className="flex items-center gap-4">
        <Avatar member={member} size={56} ring />
        <div>
          <h1 className="text-3xl font-bold">Profile</h1>
          <p className="mt-1 text-muted">{member.name}</p>
        </div>
      </div>
      <form onSubmit={submit} noValidate className="space-y-4 rounded-xl border border-line bg-navy-900/70 p-5" aria-labelledby={`${uid}-title`}>
        <h2 id={`${uid}-title`} className="flex items-center gap-2 font-semibold">
          <Lock size={18} aria-hidden className="text-electric-soft" /> {title}
        </h2>
        {screen === "set" && <p className="text-sm text-muted">Choose a password to protect your Profile (at least 6 characters). You will enter it each time you open your Profile.</p>}

        {screen === "recover" ? (
          <div>
            <label htmlFor={`${uid}-answer`} className="mb-1.5 block text-sm font-medium">What is the name of your favourite game?</label>
            <input id={`${uid}-answer`} type="password" autoComplete="off" value={answer} onChange={(e) => setAnswer(e.target.value)} maxLength={200} className={input} />
          </div>
        ) : (
          <div>
            <label htmlFor={`${uid}-pw`} className="mb-1.5 block text-sm font-medium">{screen === "set" ? "Set Password" : "Password"}</label>
            <input id={`${uid}-pw`} type="password" autoComplete={screen === "set" ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} maxLength={128} className={input} />
          </div>
        )}
        {screen === "set" && (
          <div>
            <label htmlFor={`${uid}-confirm`} className="mb-1.5 block text-sm font-medium">Confirm Password</label>
            <input id={`${uid}-confirm`} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} maxLength={128} className={input} />
          </div>
        )}

        {error && <p role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-100">{error}</p>}
        {showReset && <p role="status" className="rounded-lg border border-line bg-navy-950/60 px-3 py-2 text-sm">Please contact the Admin to reset your password.</p>}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {screen === "unlock" && (
              <button type="button" className="text-electric-soft hover:underline" onClick={() => { setShowReset(true); setError(null); }}>
                Reset Password
              </button>
            )}
            {isAdmin && screen === "unlock" && (
              <button type="button" className="text-electric-soft hover:underline" onClick={() => { setScreen("recover"); setError(null); setShowReset(false); }}>
                Another way to unlock
              </button>
            )}
            {screen === "recover" && (
              <button type="button" className="text-electric-soft hover:underline" onClick={() => { setScreen("unlock"); setError(null); }}>
                Use my password
              </button>
            )}
          </div>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "Checking…" : screen === "set" ? "Save password" : "Unlock"}
          </Button>
        </div>
      </form>
      <LogoutSection member={member} />
    </div>
    </div>
  );
}
