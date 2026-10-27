import { ErrorState } from "@/components/ui/empty-state";
import { GmailConnect } from "@/components/gmail/gmail-connect";
import { MEMBER_IDS } from "@/config/members";
import { gmailOverview } from "@/lib/gmail/overview";
import { loadForMember } from "@/lib/pages/load";

export const metadata = { title: "Gmail drafts · JobSync" };

/** Each member connects THEIR OWN Gmail so Network Finder can save drafts there (drafts only, never sent). */
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
  return <GmailConnect overview={result.data} justConnected={connected === "1"} error={typeof error === "string" ? error : undefined} />;
}
