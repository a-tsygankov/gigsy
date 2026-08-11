/**
 * The published privacy policy.
 *
 * Google's OAuth verification needs this at a real URL, reachable
 * without signing in and linked from the page a reviewer lands on — so
 * it sits outside AuthGate and the login screen links to it.
 *
 * `docs/privacy-policy.md` is the source of record and carries the same
 * text. If you change one, change the other; a policy that disagrees
 * with itself is worse than one that is merely out of date.
 */
import { Link } from "react-router-dom";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6">
      <h2 className="text-base font-semibold text-slate-900">{title}</h2>
      <div className="mt-2 space-y-2 text-sm leading-relaxed text-slate-600">
        {children}
      </div>
    </section>
  );
}

/** Rows are `[what, why]`; the header differs per table. */
function Table({
  headers,
  rows,
}: {
  headers: [string, string];
  rows: [string, string][];
}) {
  return (
    // Tables are the one thing on this page that can outgrow a phone,
    // so this one scrolls inside itself rather than widening the page.
    <div className="overflow-x-auto">
      <table className="mt-2 w-full min-w-[28rem] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200">
            <th className="py-2 pr-4 font-medium text-slate-700">{headers[0]}</th>
            <th className="py-2 font-medium text-slate-700">{headers[1]}</th>
          </tr>
        </thead>
        <tbody className="text-slate-600">
          {rows.map(([a, b]) => (
            <tr key={a} className="border-b border-slate-100 align-top">
              <td className="py-2 pr-4">{a}</td>
              <td className="py-2">{b}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Privacy() {
  return (
    <main className="min-h-dvh bg-slate-50 px-5 py-10 text-slate-900">
      <div className="mx-auto w-full max-w-2xl" data-testid="privacy-policy">
        <h1 className="text-2xl font-bold tracking-tight">Privacy Policy</h1>
        <p className="mt-1 text-xs text-slate-500">Last updated: 10 August 2026</p>

        <p className="mt-4 text-sm leading-relaxed text-slate-600">
          Gigsy is a personal tracker for one-off gig work: the jobs you take,
          who you take them for, what you are owed, and what you spend. It is
          run privately by its author, sells nothing, and carries no analytics,
          advertising or tracking of any kind.
        </p>

        <Section title="What is stored, and why">
          <Table
            headers={["Data", "Why it exists"]}
            rows={[
              ["Your email and Google account id", "To sign you in and keep your records separate from everyone else's"],
              ["Gigs: client, title, date, duration, location, amounts, notes", "The records the app exists to keep"],
              ["Clients, expenses, payments, services", "The same"],
              ["Receipt and capture images", "So an expense has its proof attached"],
              ["Your settings", "Working hours, timezone, reminders, notification thresholds"],
              ["An encrypted Google refresh token", "So calendar sync can run when you are not using the app"],
              ["Push subscription endpoints", "Only if you turn notifications on"],
            ]}
          />
          <p>
            Everything is scoped to your account. Every database query is
            filtered by the user id from your verified session — that is the
            entire boundary between your records and anyone else's.
          </p>
        </Section>

        <Section title="Your Google Calendar">
          <p>
            Calendar access is asked for separately from sign-in, and the app
            works without it.
          </p>
          <p>
            <strong className="font-medium text-slate-700">Writing.</strong>{" "}
            Confirmed gigs with a date become events on the calendar you
            choose. Leads never do. Deleting a gig deletes its event. Gigsy
            never modifies or deletes an event it did not create.
          </p>
          <p>
            <strong className="font-medium text-slate-700">Reading.</strong>{" "}
            Only if you switch on “use my Google Calendar” for the availability
            page. Gigsy reads <em>free/busy ranges only</em>, through Google's
            freebusy API, which returns times and never event titles,
            descriptions, locations or attendees. Those ranges compute your free
            time and are then discarded — they are never written to the
            database.
          </p>
        </Section>

        <Section title="The shareable availability link">
          <p>
            If you create one, anyone holding the link sees your free time, the
            display name you chose, and your timezone — with no sign-in.
          </p>
          <p>
            They cannot see who you work for, where, what you are paid, or how
            many gigs you have. Booked time appears only as a gap, and a gap
            caused by a gig is indistinguishable from one caused by a dentist
            appointment or a day off.
          </p>
          <p>
            The link is a random 128-bit token, and only a fingerprint of it is
            stored — so it cannot be recovered or reissued. Replacing or
            switching it off stops it working immediately.
          </p>
        </Section>

        <Section title="Who else your data reaches">
          <Table
            headers={["Service", "What reaches it, and when"]}
            rows={[
              ["Cloudflare", "Everything — it hosts the app and stores the database and images"],
              ["Google (Sign-In, Calendar)", "Your email for sign-in; gig titles, locations, notes and times for events you sync"],
              ["Google Gemini", "The text of an email you forward, or the image you capture — only when you use capture"],
              ["Anthropic", "The same content, only if the Gemini extraction fails and a fallback is configured"],
              ["OpenStreetMap (Nominatim)", "Your coordinates, only when you tap “use my current location”"],
            ]}
          />
          <p className="rounded-xl bg-amber-50 px-3 py-2 text-amber-800">
            <strong className="font-medium">Capture content leaves Gigsy.</strong>{" "}
            Forwarding an email or capturing a photo sends that content to an AI
            provider to be read. Do not send anything you would not put into a
            third party's system.
          </p>
        </Section>

        <Section title="Security">
          <ul className="list-disc space-y-1 pl-5">
            <li>
              Sessions are short-lived signed tokens; the longer-lived refresh
              token is stored only as a hash and replaced on every use, so a
              stolen one stops working.
            </li>
            <li>Your Google refresh token is encrypted at rest (AES-256-GCM).</li>
            <li>Availability link tokens are stored only as hashes.</li>
            <li>
              The public availability page asks search engines not to index it
              and caches not to store it.
            </li>
          </ul>
          <p>
            No system is perfectly secure, and this one is maintained by one
            person. Judge it accordingly.
          </p>
        </Section>

        <Section title="Retention and deletion">
          <p>
            Your records stay until you delete them. Deleting a gig, client,
            expense or payment removes it from the database.
          </p>
          <p>
            To remove your account and everything in it, ask the person who runs
            this deployment — there is no self-serve delete yet. Disconnecting
            Google Calendar in Settings erases the stored refresh token
            immediately, and revoking access from your{" "}
            <a
              className="underline"
              href="https://myaccount.google.com/permissions"
              target="_blank"
              rel="noreferrer"
            >
              Google account permissions
            </a>{" "}
            stops all calendar access at once.
          </p>
        </Section>

        <Section title="Children">
          <p>
            Gigsy is for adults tracking paid work. It is not intended for
            anyone under 16.
          </p>
        </Section>

        <Section title="Contact">
          <p>
            Questions, corrections, or a deletion request: contact the person
            who invited you and runs this deployment.
          </p>
        </Section>

        <p className="mt-8">
          <Link to="/login" className="text-sm underline text-slate-600">
            Back to sign-in
          </Link>
        </p>
      </div>
    </main>
  );
}
