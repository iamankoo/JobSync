import { redirect } from "next/navigation";
import { PageHeader } from "@/components/layout/page-header";
import { getMember } from "@/config/members";
import { getSession } from "@/lib/auth/session";

export const metadata = { title: "Dashboard · JobSync" };

export default async function DashboardPage() {
  const session = await getSession();
  const member = session && getMember(session.memberId);
  if (!member) redirect("/login");
  return (
    <PageHeader
      title={`Welcome back, ${member.name}`}
      subtitle="Your dashboard metrics arrive in Phase 4."
    />
  );
}
