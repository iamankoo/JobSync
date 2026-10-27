"use client";

import { LogOut } from "lucide-react";
import type { Member } from "@/config/members";
import { Button } from "@/components/ui/button";
import { useLogout } from "@/lib/client/use-logout";

/** Bottom of the Profile page: the app's Log out (also shown when the profile data cannot be loaded). */
export function LogoutSection({ member }: { member: Member }) {
  const { logout, busy } = useLogout();
  return (
    <section aria-labelledby="account-heading" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-navy-900/70 p-5">
      <div>
        <h2 id="account-heading" className="font-semibold">Signed in as {member.name}</h2>
        <p className="text-sm text-muted">Logging out ends your session on this device.</p>
      </div>
      <Button onClick={logout} disabled={busy}>
        <LogOut size={16} aria-hidden />
        {busy ? "Logging out…" : "Log out"}
      </Button>
    </section>
  );
}
