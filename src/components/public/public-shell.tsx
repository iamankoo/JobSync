import Link from "next/link";
import { Logo } from "@/components/ui/logo";

/** Support address shown on the public pages. Set LEGAL_CONTACT_EMAIL in the environment; when unset no address is invented. */
export const contactEmail = () => (process.env.LEGAL_CONTACT_EMAIL ?? "").trim();

/** Shared frame for the public (no sign-in) pages: homepage, privacy policy and terms. */
export function PublicShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-navy-950 text-ink">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-4 px-5 py-4">
          <Link href="/" aria-label="JobSync home">
            <Logo />
          </Link>
          <nav aria-label="Public pages" className="flex items-center gap-5 text-sm text-muted">
            <Link href="/privacy" className="hover:text-ink">Privacy</Link>
            <Link href="/terms" className="hover:text-ink">Terms</Link>
            <Link href="/login" className="rounded-lg bg-electric px-4 py-2 font-medium text-white hover:opacity-90">Sign in</Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-5 py-10">{children}</main>
      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3 px-5 py-6 text-sm text-muted">
          <span>© JobSync. A private tool for a small team.</span>
          <span className="flex gap-5">
            <Link href="/privacy" className="hover:text-ink">Privacy Policy</Link>
            <Link href="/terms" className="hover:text-ink">Terms of Service</Link>
          </span>
        </div>
      </footer>
    </div>
  );
}

export function LegalSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-xl font-semibold">{title}</h2>
      <div className="mt-3 space-y-3 leading-relaxed text-muted [&_li]:ml-5 [&_li]:list-disc [&_strong]:text-ink">{children}</div>
    </section>
  );
}
