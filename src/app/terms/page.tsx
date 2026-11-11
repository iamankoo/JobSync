import Link from "next/link";
import { contactEmail, LegalSection, PublicShell } from "@/components/public/public-shell";

export const metadata = {
  title: "Terms of Service · JobSync",
  description: "The terms for using JobSync, a private job-search workspace for a small team.",
  robots: { index: true, follow: true },
};

const UPDATED = "11 November 2026";

export default function TermsPage() {
  const email = contactEmail();
  return (
    <PublicShell>
      <h1 className="text-4xl font-bold tracking-tight">Terms of Service</h1>
      <p className="mt-2 text-sm text-muted">Last updated: {UPDATED}</p>
      <p className="mt-5 leading-relaxed text-muted">
        These terms apply to JobSync, a private job-search workspace for a small, fixed team. By signing in or connecting a Google account you
        agree to them. If you do not agree, do not use JobSync.
      </p>

      <LegalSection title="Who may use JobSync">
        <p>JobSync is available only to the team members it has been set up for. Access is by a personal access code, which you must keep secret and not share. You are responsible for activity under your account.</p>
      </LegalSection>

      <LegalSection title="What JobSync does">
        <p>JobSync helps members track jobs and applications, manage a contact list, and prepare personalised outreach emails. With a member&apos;s permission it creates drafts in that member&apos;s own Gmail and, depending on the team&apos;s configured workflow, sends those drafts automatically from that same account, as described in the <Link href="/privacy" className="text-electric-soft underline">Privacy Policy</Link>.</p>
      </LegalSection>

      <LegalSection title="Your responsibilities">
        <ul>
          <li>Connect only your own Google account, and keep your résumé and profile information accurate.</li>
          <li>Use JobSync only to contact people about genuine job and networking opportunities. Do not use it for spam, harassment, deception or anything unlawful, and follow the laws on commercial email that apply to you and the recipients.</li>
          <li>Honour opt-out requests: if someone asks not to be contacted, record it so they are not emailed again.</li>
          <li>Respect Google&apos;s and Gmail&apos;s terms and sending limits. Emails are sent from your own account, and its quotas and any restrictions Google applies are not controlled by JobSync.</li>
          <li>Do not attempt to access other members&apos; data or accounts, disrupt the service, or probe it for weaknesses.</li>
        </ul>
      </LegalSection>

      <LegalSection title="Automatic sending">
        <p>Where automatic sending is enabled, emails go out from your Gmail without a further confirmation each time. You can review drafts in your Gmail, and you can stop JobSync at any time by disconnecting Gmail in JobSync or revoking its access in your Google account.</p>
      </LegalSection>

      <LegalSection title="Your data and ending use">
        <p>Your data stays yours. You may stop using JobSync at any time and ask for your personal data to be deleted. Access may be suspended or ended for misuse.</p>
      </LegalSection>

      <LegalSection title="No warranty and limits of liability">
        <p>JobSync is provided &quot;as is&quot;, without warranties of any kind. It depends on third-party services (including Google and the hosting provider) that may be unavailable or change. Emails may be delayed, fail or be rejected, and JobSync does not guarantee any reply, interview or job outcome. To the extent permitted by law, the operators are not liable for indirect or consequential losses arising from use of JobSync.</p>
      </LegalSection>

      <LegalSection title="Changes and contact">
        <p>These terms may be updated; the date above shows the latest version, and continued use means you accept the update. Questions: {email ? <a className="text-electric-soft underline" href={`mailto:${email}`}>{email}</a> : "please contact the JobSync administrator through the team"}.</p>
        <p><Link href="/privacy" className="text-electric-soft underline">Privacy Policy</Link> · <Link href="/" className="text-electric-soft underline">Home</Link></p>
      </LegalSection>
    </PublicShell>
  );
}
