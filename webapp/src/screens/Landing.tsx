/**
 * The public front door.
 *
 * Exists for two audiences at once. The first is someone who was sent a
 * link and has no idea what this is. The second is a Google OAuth
 * reviewer, who requires a home page that is "publicly accessible, and
 * not just accessible to your site's logged-in users", describes the
 * app, and links to the privacy policy. A bare sign-in box fails that
 * check — it was the gap that blocked verification.
 *
 * Two constraints follow from the reviewer, and both are easy to undo
 * by accident:
 *
 * 1. **It fetches nothing.** No config call, no session probe. A home
 *    page that renders a spinner when the API is slow reads as broken,
 *    and "your home page URL is unresponsive" is a real rejection
 *    reason. This page is static and renders offline.
 *
 * 2. **The Calendar section must keep matching the scopes actually
 *    requested.** Reviewers compare the described behaviour against the
 *    consent screen. If the scopes in `google-signin.ts` change, change
 *    the wording here and in `docs/google-oauth-verification.md`.
 *
 * Colours come from the token palette, so this page themes with the
 * rest of the app and needs no `dark:` variants.
 */
import { Link } from "react-router-dom";

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-10">
      <h2 className="text-lg font-semibold tracking-tight text-slate-900">
        {title}
      </h2>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-slate-600">
        {children}
      </div>
    </section>
  );
}

function Feature({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
      <p className="mt-1 text-sm leading-relaxed text-slate-600">{body}</p>
    </div>
  );
}

const FEATURES: { title: string; body: string }[] = [
  {
    title: "Gigs and clients",
    body: "Every job you take, who it was for, when it ran, and how long. Leads stay separate from confirmed work.",
  },
  {
    title: "What you are owed",
    body: "Fees, expenses and payments per gig, so an unpaid invoice is visible rather than remembered.",
  },
  {
    title: "Works with no signal",
    body: "Install it and it keeps working underground or backstage. Changes queue up and sync when you surface.",
  },
  {
    title: "Capture without typing",
    body: "Forward a booking email or photograph a receipt, and the details are read out into a draft for you to check.",
  },
];

export function Landing() {
  return (
    <main className="min-h-dvh bg-slate-50 px-5 py-12 text-slate-900">
      <div className="mx-auto w-full max-w-2xl" data-testid="landing">
        <h1 className="text-4xl font-bold tracking-tight">Gigsy</h1>
        <p className="mt-3 text-base leading-relaxed text-slate-600">
          A personal tracker for one-off gig work — the jobs you take, who you
          take them for, what you are owed, and what you spend. Built for
          people working across many agencies rather than one employer.
        </p>

        <div className="mt-7 flex flex-wrap items-center gap-3">
          <Link
            to="/login"
            data-testid="landing-signin"
            className="rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-on-accent
                       transition-colors hover:bg-accent-hover focus:outline-none
                       focus-visible:ring-2 focus-visible:ring-emerald-500"
          >
            Sign in with Google
          </Link>
          <span className="text-xs text-slate-500">
            Invite only — accounts are added by hand.
          </span>
        </div>

        <div className="mt-10 grid gap-3 sm:grid-cols-2">
          {FEATURES.map((f) => (
            <Feature key={f.title} title={f.title} body={f.body} />
          ))}
        </div>

        {/* The section a verification reviewer is looking for. Split in
            two because Gigsy asks for the two Calendar scopes at
            different moments and for unrelated reasons — describing them
            as one "calendar access" would misrepresent both. */}
        <Section title="How Gigsy uses your Google Calendar">
          <p>
            Calendar access is asked for separately from signing in, and never
            bundled into it. The app is fully usable without ever granting it.
          </p>
          <p>
            <strong className="font-medium text-slate-700">
              Writing your gigs onto a calendar.
            </strong>{" "}
            Confirmed gigs that have a date become events on a calendar you
            pick, so your bookings show up next to the rest of your life.
            Deleting a gig deletes its event. Gigsy never touches an event it
            did not create.
          </p>
          <p>
            <strong className="font-medium text-slate-700">
              Reading when you are busy.
            </strong>{" "}
            Optional, off by default, and only useful if you publish an
            availability link. Gigsy reads <em>free/busy times only</em> —
            through Google's freebusy API, which returns busy ranges and never
            event titles, descriptions, locations or guests. Those ranges are
            used to work out your free time and then discarded. They are never
            stored.
          </p>
          <p>
            You can withdraw either at any time, from Settings or from your{" "}
            <a
              className="underline"
              href="https://myaccount.google.com/permissions"
              target="_blank"
              rel="noreferrer"
            >
              Google account permissions
            </a>
            .
          </p>
        </Section>

        <Section title="Sharing when you are free">
          <p>
            You can publish one link that shows an agency when you are
            available, so booking you does not take four messages. It shows
            your free time, the name you chose, and your timezone — nothing
            else.
          </p>
          <p>
            Whoever holds it cannot see who you work for, where, what you are
            paid, or how many jobs you have. Busy time appears only as a gap,
            and a gap caused by a gig looks exactly like one caused by a
            dentist appointment. You can switch the link off whenever you want,
            and it stops working immediately.
          </p>
        </Section>

        <Section title="Your data">
          <p>
            Gigsy sells nothing, shows no advertising, and carries no
            analytics or tracking. Your records exist to be shown back to you.
            The{" "}
            <Link className="underline" to="/privacy" data-testid="landing-privacy-link">
              privacy policy
            </Link>{" "}
            sets out exactly what is stored, which services it reaches, and how
            to have it deleted.
          </p>
        </Section>

        <footer className="mt-12 border-t border-slate-200 pt-6 text-xs text-slate-500">
          <p>
            Gigsy is run privately by its author.{" "}
            <Link className="underline" to="/privacy">
              Privacy policy
            </Link>
            . Questions or a deletion request: contact whoever invited you.
          </p>
        </footer>
      </div>
    </main>
  );
}
