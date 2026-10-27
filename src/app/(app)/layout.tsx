import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { getMember, type MemberId } from "@/config/members";
import { getSession } from "@/lib/auth/session";
import { appTimezone } from "@/lib/google-sheets/config";
import { recordVisit } from "@/lib/google-sheets/activity-service";
import { getDueFollowUps } from "@/lib/google-sheets/follow-up-service";
import { isMemberActive } from "@/lib/google-sheets/members-service";
import { photoVersions } from "@/lib/google-sheets/member-files-service";
import { MemberPhotosProvider } from "@/components/ui/member-photos";

export const dynamic = "force-dynamic";

/**
 * Follow-up questions due for the session member. Decided on the server from persisted UTC
 * timestamps. If the data layer is unavailable the pages show their own error states, so this
 * simply returns nothing rather than blocking the whole site.
 */
async function dueFollowUps(memberId: MemberId) {
  try {
    if (!(await isMemberActive(memberId))) return [];
    // The session is valid and the member is active: note the visit (at most one per 30 minutes)
    // while checking what is due. A failed visit write never affects the page.
    const [{ due }] = await Promise.all([getDueFollowUps(memberId), recordVisit(memberId)]);
    return due.map(({ jobId, company, jobRole, appliedAt }) => ({ jobId, company, jobRole, appliedAt }));
  } catch (err) {
    console.error("[follow-up] could not check due follow-ups", err instanceof Error ? err.name : typeof err);
    return [];
  }
}

/** Uploaded professional photos for avatars; the built-in photos are used if this cannot be read. */
async function uploadedPhotos() {
  try {
    return await photoVersions();
  } catch (err) {
    console.error("[profile] could not read uploaded photos", err instanceof Error ? err.name : typeof err);
    return {};
  }
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Identity always comes from the validated session cookie, never from the browser.
  const session = await getSession();
  const member = session && getMember(session.memberId);
  if (!member) redirect("/login");
  const [followUps, photos] = await Promise.all([dueFollowUps(member.id), uploadedPhotos()]);
  return (
    <MemberPhotosProvider versions={photos}>
      <AppShell member={member} followUps={followUps} timeZone={appTimezone()}>
        {children}
      </AppShell>
    </MemberPhotosProvider>
  );
}
