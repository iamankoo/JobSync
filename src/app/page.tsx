import Link from "next/link";
import { redirect } from "next/navigation";
import { PublicShell } from "@/components/public/public-shell";
import { getSession } from "@/lib/auth/session";

export const metadata = {
  title: "JobSync · Your team's job hunt, together",
  description:
    "JobSync is a private job-search workspace for a small team: shared job tracking, a contact list, and email drafts that each member reviews and sends from their own Gmail account.",
  robots: { index: true, follow: true },
};
export const dynamic = "force-dynamic";

const CARDS: [string, string][] = [
  ["Track the search", "Shared job listings, each member's applications, follow-up reminders and a team dashboard."],
  ["Keep contacts organised", "A contact list of people and companies the team wants to reach, with ownership and status."],
  ["Email drafts, in your own Gmail", "After a member connects their own Google account, JobSync creates a personalised draft with that member's own résumé attached, in that member's Gmail, and sends it from that same account."],
  ["Private by design", "Access is limited to the team members by an access code. No data is sold, shared for advertising, or used to train AI models."],
];

export default async function Home() {
  // Signed-in members still land on their dashboard, exactly as before.
  if (await getSession()) redirect("/dashboard");
  return (
    <PublicShell>
      <h1 className="text-4xl font-bold tracking-tight">Your team&apos;s job hunt, together.</h1>
      <p className="mt-4 max-w-2xl text-lg leading-relaxed text-muted">
        JobSync is a private workspace used by a small team of job seekers. It brings the team&apos;s job listings, applications, follow-ups and
        networking contacts into one place, and helps each member prepare personalised outreach emails.
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        <Link href="/login" className="rounded-lg bg-electric px-5 py-3 font-medium text-white hover:opacity-90">Sign in</Link>
        <Link href="/privacy" className="rounded-lg border border-line px-5 py-3 text-muted hover:text-ink">Privacy Policy</Link>
        <Link href="/terms" className="rounded-lg border border-line px-5 py-3 text-muted hover:text-ink">Terms of Service</Link>
      </div>

      <section className="mt-12 grid gap-4 sm:grid-cols-2">
        {CARDS.map(([t, d]) => (
          <div key={t} className="rounded-xl border border-line bg-navy-900 p-5">
            <h2 className="font-semibold">{t}</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted">{d}</p>
          </div>
        ))}
      </section>

      <section className="mt-12 rounded-xl border border-line bg-navy-900 p-5">
        <h2 className="font-semibold">How JobSync uses Google user data</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          When a member connects Gmail, JobSync asks only to create and send the drafts it prepares, and to see whether those drafts were sent.
          It does not read the contents of anyone&apos;s inbox. Read the full details in the{" "}
          <Link href="/privacy" className="text-electric-soft underline">Privacy Policy</Link>.
        </p>
      </section>
    </PublicShell>
  );
}
