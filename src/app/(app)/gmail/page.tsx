import { ErrorState } from "@/components/ui/empty-state";
import { GmailConnect } from "@/components/gmail/gmail-connect";
import { MEMBER_IDS } from "@/config/members";
import { draftListFor } from "@/lib/gmail/draft-list";
import { gmailOverview } from "@/lib/gmail/overview";
import { loadForMember } from "@/lib/pages/load";

export const metadata = { title: "Gmail drafts · JobSync" };

/**
 * Gmail Drafts: who has Gmail connected, and the signed-in member's own Network Finder drafts (Drafted / Sent)
 * from the real draft ledger. Each member connects / disconnects THEIR OWN Gmail from Profile → Gmail (drafts only,
 * never sent); Google returns them here after connecting.
 */
export default async function GmailPage({ searchParams }: { searchParams: Promise<{ connected?: string; error?: string }> }) {
  const { connected, error } = await searchParams;
  const { result } = await loadForMember(async (m) => {
    const [overview, drafts] = await Promise.all([gmailOverview(m, MEMBER_IDS), draftListFor(m)]);
    return { members: overview.members, drafts };
  });
  if (!result.ok) {
    return (
      <div className="space-y-3">
        <h1 className="text-xl font-semibold">Gmail drafts</h1>
        <ErrorState title={result.title} message={result.message} />
      </div>
    );
  }
  return <GmailConnect members={result.data.members} drafts={result.data.drafts} justConnected={connected === "1"} error={typeof error === "string" ? error : undefined} />;
}
