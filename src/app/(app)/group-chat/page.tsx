import { ChatView } from "@/components/chat/chat-view";
import { PageHeader } from "@/components/layout/page-header";
import { ErrorState } from "@/components/ui/empty-state";
import { loadForMember } from "@/lib/pages/load";

export const metadata = { title: "Group Chat · JobSync" };

export default async function GroupChatPage() {
  // The member comes from the validated session; messages are fetched by the page itself (and kept fresh by polling).
  const { result } = await loadForMember(async (memberId) => memberId);
  if (!result.ok) {
    return (
      <div className="space-y-5">
        <PageHeader title="Group Chat" subtitle="Private chat for Anni, Lukky and Rishii" />
        <ErrorState title={result.title} message={result.message} />
      </div>
    );
  }
  return <ChatView me={result.data} />;
}
