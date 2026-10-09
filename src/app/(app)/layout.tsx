import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { getMember } from "@/config/members";
import { getSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Identity always comes from the validated session cookie, never from the browser.
  const session = await getSession();
  const member = session && getMember(session.memberId);
  if (!member) redirect("/login");
  return <AppShell member={member}>{children}</AppShell>;
}
