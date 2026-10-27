import { ErrorState } from "@/components/ui/empty-state";
import { GmailConnect } from "@/components/gmail/gmail-connect";
import { MEMBER_IDS } from "@/config/members";
import { gmailOverview } from "@/lib/gmail/overview";
import { loadForMember } from "@/lib/pages/load";

export const metadata = { title: "Gmail drafts · JobSync" };

/**
 * Gmail Drafts: who has Gmail connected. Each member connects / disconnects THEIR OWN Gmail from Profile → Gmail
 * (drafts only, never sent); Google returns them here after connecting.
 */
export default async function GmailPage({ searchParams }: { searchParams: Promise<{ connected?: string; error?: string }> }) {
  const { connected, error } = await searchParams;
  const { result } = await loadForMember((m) => gmailOverview(m, MEMBER_IDS));
  if (!result.ok) {
    return (
      <div className="space-y-3">
        <h1 className="text-xl font-semibold">Gmail drafts</h1>
        <ErrorState title={result.title} message={result.message} />
      </div>
    );
  }
  return <GmailConnect members={result.data.members} justConnected={connected === "1"} error={typeof error === "string" ? error : undefined} />;
}
