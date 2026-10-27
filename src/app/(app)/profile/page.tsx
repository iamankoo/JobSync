import { LogoutSection } from "@/components/profile/logout-section";
import { ProfileGate } from "@/components/profile/profile-gate";
import { PageHeader } from "@/components/layout/page-header";
import { ErrorState } from "@/components/ui/empty-state";
import { getMember } from "@/config/members";
import { ADMIN, hasPassword } from "@/lib/profile/lock-service";
import { loadForMember } from "@/lib/pages/load";

export const metadata = { title: "Profile · JobSync" };

/**
 * The signed-in member's Profile. The page only knows whether a Profile Password exists; the profile itself is
 * sent by the server after the password (or Anni's recovery answer) is accepted.
 */
export default async function ProfilePage() {
  const { memberId, timeZone, result } = await loadForMember((m) => hasPassword(m));
  const member = getMember(memberId)!;
  if (!result.ok) {
    return (
      <div className="mx-auto w-full max-w-2xl space-y-5">
        <PageHeader title="Profile" subtitle="Your details, visible only to you." />
        <ErrorState title={result.title} message={result.message} />
        <LogoutSection member={member} />
      </div>
    );
  }
  return <ProfileGate member={member} hasPassword={result.data} isAdmin={memberId === ADMIN} timeZone={timeZone} />;
}
