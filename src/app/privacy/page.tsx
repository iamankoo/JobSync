import Link from "next/link";
import { contactEmail, LegalSection, PublicShell } from "@/components/public/public-shell";

export const metadata = {
  title: "Privacy Policy · JobSync",
  description: "How JobSync handles Gmail access, email drafting and sending, Google Sheets storage, account information and other data.",
  robots: { index: true, follow: true },
};

const UPDATED = "11 November 2026";

export default function PrivacyPage() {
  const email = contactEmail();
  return (
    <PublicShell>
      <h1 className="text-4xl font-bold tracking-tight">Privacy Policy</h1>
      <p className="mt-2 text-sm text-muted">Last updated: {UPDATED}</p>
      <p className="mt-5 leading-relaxed text-muted">
        JobSync is a private job-search workspace operated for a small, fixed team of three members. It is not a public service: only those team
        members can sign in. This policy explains what information JobSync handles, why, and what it never does.
      </p>

      <LegalSection title="Information JobSync handles">
        <ul>
          <li><strong>Account information.</strong> Each member&apos;s name, profile details they enter (for example links, role preferences), a profile password stored only as a salted hash, and the access code used to sign in (checked on the server, never shown to the browser).</li>
          <li><strong>Job-search data.</strong> Job listings, applications, follow-ups, notes, chat messages between members and notifications.</li>
          <li><strong>Contacts.</strong> Business contact details (names, work email addresses, companies, roles) of people the team wishes to contact about job opportunities, the status of each outreach, and a ledger of what has been drafted and sent.</li>
          <li><strong>Résumés.</strong> Each member&apos;s own résumé file, used only as the attachment on that member&apos;s own drafts.</li>
          <li><strong>Notification settings.</strong> If a member turns on push notifications, the browser&apos;s push subscription for that device.</li>
        </ul>
      </LegalSection>

      <LegalSection title="Google user data (Gmail)">
        <p>A member may connect their <strong>own</strong> Google account to JobSync. Each member connects only their own account, through Google&apos;s consent screen. JobSync requests these permissions:</p>
        <ul>
          <li><strong>OpenID / email address</strong> to know which Gmail address was connected.</li>
          <li><strong>Gmail: compose</strong> (<code>gmail.compose</code>) to create email drafts in the member&apos;s Gmail, to send the drafts JobSync itself created, and to count and clean up those JobSync-created drafts.</li>
          <li><strong>Gmail: metadata</strong> (<code>gmail.metadata</code>), read-only, to check the labels of the conversation of a draft JobSync created, so it can tell whether that draft was sent or deleted. JobSync does not read message bodies.</li>
        </ul>
        <p><strong>How the data is used.</strong> JobSync prepares a personalised email for each eligible contact and saves it as a draft in the member&apos;s own Gmail with that member&apos;s own résumé attached. Depending on the team&apos;s configured workflow, the drafts JobSync created are then sent automatically from that same member&apos;s Gmail account. Before each send JobSync checks that the draft is one it created, that the correct résumé is attached, that the recipient has not opted out, and that it has not already been sent.</p>
        <p><strong>What JobSync does not do.</strong> It does not read, search or copy the content of a member&apos;s inbox or other emails; it does not touch drafts a member wrote by hand; it does not send from one member&apos;s account on behalf of another; it does not sell Google user data, use it for advertising, or use it to train artificial-intelligence or machine-learning models; and it does not let humans read Google user data except where a member shows it to a teammate or where required by law.</p>
        <p><strong>Storage of the Google token.</strong> Google gives JobSync a refresh token for each connected account. It is encrypted (AES-256-GCM, bound to that member) before it is stored, so the spreadsheet alone cannot be used to reach anyone&apos;s mailbox. A member can disconnect at any time from the Gmail page in JobSync, which deletes the stored token, or revoke access at <a className="text-electric-soft underline" href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>.</p>
        <p>JobSync&apos;s use and transfer of information received from Google APIs adheres to the{" "}
          <a className="text-electric-soft underline" href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>
      </LegalSection>

      <LegalSection title="Where data is stored (Google Sheets)">
        <p>JobSync has no separate database. Its records live in Google Sheets spreadsheets owned by the team, which JobSync reads and writes through a Google service account: the job-search data, the contact lists, the send ledger, draft records and the encrypted Gmail tokens described above. Access to those spreadsheets is limited to the team. The website is hosted on Netlify, which processes requests on JobSync&apos;s behalf.</p>
      </LegalSection>

      <LegalSection title="Third-party services">
        <p>To find companies and business contacts and to help write email text, JobSync&apos;s networking features may send company, job and business-contact information (never Gmail content or inbox data) to commercial data and AI-text providers. Push notifications are delivered through the browser vendor&apos;s push service. JobSync does not share Google user data with any of these.</p>
      </LegalSection>

      <LegalSection title="People who receive an email">
        <p>Recipients get an ordinary email from a member&apos;s own Gmail address. If a recipient asks not to be contacted again, the team records an opt-out and JobSync will not email that address again.</p>
      </LegalSection>

      <LegalSection title="Retention and deletion">
        <p>Records are kept while the team uses JobSync. Old job listings are removed after a retention period. Disconnecting Gmail deletes that member&apos;s stored Google token immediately. A member may ask for their personal data to be corrected or deleted, and the team will do so unless a record must be kept (for example an opt-out, so the person is not emailed again).</p>
      </LegalSection>

      <LegalSection title="Security">
        <p>Access is limited by an access code checked on the server, sessions use signed, HTTP-only cookies over HTTPS, the profile password is stored as a salted hash, Google tokens are encrypted at rest, and secrets are kept in server-side configuration, never in the browser.</p>
      </LegalSection>

      <LegalSection title="Changes and contact">
        <p>If this policy changes, the date above is updated. Questions, correction or deletion requests: {email ? <a className="text-electric-soft underline" href={`mailto:${email}`}>{email}</a> : "please contact the JobSync administrator through the team"}.</p>
        <p><Link href="/terms" className="text-electric-soft underline">Terms of Service</Link> · <Link href="/" className="text-electric-soft underline">Home</Link></p>
      </LegalSection>
    </PublicShell>
  );
}
