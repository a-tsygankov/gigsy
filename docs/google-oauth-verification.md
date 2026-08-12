# Google OAuth verification — submission pack

Everything needed to submit Gigsy for OAuth app verification, written
out so the submission is a copy-paste job rather than a fresh act of
composition under time pressure.

**Read this first:** you probably do not need to submit at all. See
[Do you actually need this?](#do-you-actually-need-this) below.

---

## What Gigsy asks Google for

Declared in [`webapp/src/lib/google-signin.ts`](../webapp/src/lib/google-signin.ts).
If that file changes, this document and the landing page's Calendar
section are both wrong until updated.

| Scope | Category | Asked for when |
| --- | --- | --- |
| `openid`, `email`, `profile` (via Google Identity Services) | Non-sensitive | Signing in |
| `https://www.googleapis.com/auth/calendar.events` | **Sensitive** | Connecting Calendar in Settings — never at sign-in |
| `https://www.googleapis.com/auth/calendar.readonly` | **Sensitive** | Only when switching on "use my Google Calendar" for the availability page. **Should be `calendar.freebusy`** — far narrower and sufficient; see [google-oauth-scopes.md](google-oauth-scopes.md) |

Both Calendar scopes are **sensitive**, not **restricted**. That
distinction is worth more than it looks: restricted scopes (Gmail,
Drive) require an annual third-party CASA security assessment costing
thousands. Sensitive scopes require review, a demo video, and a verified
domain — no paid assessment.

---

## Do you actually need this?

Google exempts apps for personal use with **fewer than 100 users** from
verification. The cost of not verifying is:

- an "unverified app" interstitial each user clicks through once
  (Advanced → Go to Gigsy), and
- a hard cap of 100 accounts that can ever grant access.

Against that, moving the publishing status from **Testing** to
**Production** — with or without verification — fixes the thing that
actually hurts: in Testing, **refresh tokens expire after 7 days**, so
calendar sync dies weekly and everyone has to reconnect. Production
issues long-lived refresh tokens.

**So: switch to Production now; verify only when you outgrow 100 users
or the warning screen starts costing you.**

### Order matters here

Google's Testing mode is doing real work today: its test-user list is
the only thing keeping strangers out, because an unset `ALLOWED_EMAILS`
admits everyone. Switching to Production removes that gate. So:

1. **Set `ALLOWED_EMAILS` first**, and confirm it took effect —
   `GET /api/auth/config` reports `inviteOnly: true` once a list is in
   force.
2. **Then** switch the publishing status to Production.

Doing it the other way round leaves a window in which any Google account
on earth can sign in. The window may be short, but it is the kind of
thing that is only noticed afterwards.

`ALLOWED_EMAILS` is a **secret**, set with:

```
wrangler secret put ALLOWED_EMAILS
```

Paste the whole comma-separated list — it replaces rather than appends,
so adding a tester means re-entering everyone, and dropping yourself
locks you out of your own deployment.

It must never be added to wrangler.toml `[vars]`. The repo is public, so
a var would publish the addresses; and the two cannot coexist anyway —
Cloudflare rejects the secret while a var of that name is bound:

```
Binding name 'ALLOWED_EMAILS' already in use  [code: 10053]
```

Which means the ordering is forced: the `[vars]` entry has to be gone
from the **deployed** Worker before the secret can be set at all.
`backend/test/allowlist-config.test.ts` fails if anyone re-adds it.

---

## Scope justifications

Paste these into the Data Access screen. Each answers the question the
reviewer is actually asking, which is not "what does your app do" but
"why can this feature not work with less access".

### `calendar.events`

> Gigsy is a work tracker for freelancers who take one-off jobs across
> many agencies. When a user confirms a booking, Gigsy writes it to a
> Google Calendar of their choosing as an event, so their paid work
> appears alongside the rest of their life rather than only inside our
> app. When a booking moves or is cancelled, Gigsy updates or deletes
> the event it created. Gigsy never modifies or deletes an event it did
> not create.
>
> A narrower scope does not exist for this. `calendar.app.created` is
> not sufficient: users overwhelmingly want their gigs on a calendar
> they already keep and already share with family or an agent, not on a
> separate app-owned calendar they would have to subscribe to
> separately. `calendar.events` is the narrowest scope that can write an
> event to a calendar the user already owns, and Gigsy requests it only
> when the user explicitly connects Calendar in Settings — never as part
> of signing in. The app is fully functional without it.

### `calendar.readonly` — do not submit this; switch the scope instead

> [!WARNING]
> **The justification below is wrong and must not be submitted as it
> stands.** It argued that the `freeBusy` endpoint has no narrower
> scope. It has two: the
> [API reference](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query)
> lists `calendar.freebusy` and `calendar.events.freebusy` alongside
> `calendar.readonly` and `calendar`.
>
> A reviewer reading the same page would refute this in one line, and
> "we asked for more than we needed and said we had to" is a bad
> position to be caught in. **Switch the app to `calendar.freebusy`**
> — see [google-oauth-scopes.md](google-oauth-scopes.md) — and this
> justification stops being needed at all. The paragraphs below are
> kept only because their description of *what Gigsy does with the
> data* is accurate and reusable for whichever scope replaces it.

> Gigsy lets a user publish a single link showing an agency when they
> are free to be booked, which replaces a back-and-forth of messages.
> That page is only correct if it accounts for commitments the user did
> not enter into Gigsy — a dentist appointment, a school run, a day job.
>
> To do that, Gigsy calls the **Calendar `freebusy` API**
> (`calendars.freebusy` / `POST /freeBusy`), which returns nothing but
> start and end times of busy periods. It returns no event titles,
> descriptions, locations, attendees, or attachments. Gigsy uses those
> ranges to subtract busy time from the user's working hours, then
> discards them. Free/busy data is never written to our database, never
> logged, and never shown to anyone holding the availability link — a
> viewer sees only a gap, and a gap caused by a gig is indistinguishable
> from one caused by a personal appointment.
>
> **On why this is the narrowest scope available:** `calendar.freebusy`
> is the narrowest of the four scopes `freebusy.query` accepts, and it
> is the one Gigsy requests. `calendar.app.created` cannot serve this
> feature at all — it covers only events our own app created, which is
> precisely the data we do *not* need to read, since the whole point is
> the commitments Gigsy does not know about.
>
> This scope is **off by default**, is never bundled into sign-in or
> into connecting Calendar, and is requested only at the moment a user
> switches on "use my Google Calendar" for their availability page. A
> user who declines still gets an availability page, built from Gigsy
> bookings alone, and the page states which basis it used.

### Limited Use compliance

> Gigsy's use of information received from Google APIs adheres to the
> Google API Services User Data Policy, including the Limited Use
> requirements. Google user data is used solely to provide the
> user-facing features described above. It is not sold, not used for
> advertising, not used to train generalised AI models, and not
> transferred to third parties except as required to provide the service
> (hosting) or as required by law. Gigsy carries no analytics or
> advertising of any kind. Humans do not read user data except where a
> user explicitly requests support.

---

## Prerequisites checklist

| # | Requirement | State | Notes |
| --- | --- | --- | --- |
| 1 | Public home page describing the app | ✅ | `/` — [`webapp/src/screens/Landing.tsx`](../webapp/src/screens/Landing.tsx). Guarded by `webapp/e2e/landing.spec.ts` |
| 2 | Privacy policy, public, same domain, linked from home page | ✅ | `/privacy` — linked from both the landing page and the login screen |
| 3 | Home page reachable without an account | ✅ | Outside the redirect; renders with the API unreachable |
| 4 | **A domain you own** | ❌ | Currently Cloudflare Pages. Verification wants a top private domain you control in Search Console. `wrangler.toml` already references `gigsy.app` |
| 5 | Domain verified in Google Search Console | ❌ | Same Google account as the Cloud project owner, or it stalls immediately |
| 6 | Authorized domain set on the consent screen | ❌ | Follows from 4 |
| 7 | App name, logo, support email on the consent screen | ❌ | Must match the live app — reviewers compare them |
| 8 | Demo video (unlisted YouTube) | ❌ | Shot list below |
| 9 | Scope justifications | ✅ | Above |
| 10 | `ALLOWED_EMAILS` set | ❌ | A **Worker secret**, never a `[vars]` entry — the repo is public and the list is other people's addresses. Set it **before** switching to Production |

Items 4–8 are the real work, and 4 gates 5 and 6. Buying the domain also
unblocks the email-capture work, which was waiting on a domain for the
Email Routing catch-all — one purchase, two blockers.

---

## Demo video shot list

Unlisted YouTube, in English, no cuts that skip the consent screen.
Reviewers reject videos that show the app but not the grant.

1. **Start on the home page** at the verified domain. Show the URL bar.
2. **Sign in with Google.** During consent, pause so that both are
   legible: the **app name** on the consent screen, and the **client ID**
   in the browser address bar. This is the single most common reason a
   video is rejected.
3. **Settings → Connect Google Calendar.** Show the separate consent
   prompt for `calendar.events`. Say aloud that sign-in did not ask for
   this.
4. **Create a confirmed gig with a date.** Switch to Google Calendar and
   show the event that appeared. Delete the gig; show the event go.
5. **Settings → availability → switch on "use my Google Calendar".**
   Show the *separate* consent prompt for `calendar.readonly`.
6. **Put a personal appointment on the Google Calendar** — give it an
   obvious title like "Dentist — Dr Smith, 3pm".
7. **Open the public availability link in a private window.** Show that
   the time is blocked out and that **the title is nowhere on the page**.
   This is the shot that earns `calendar.readonly`: it demonstrates
   free/busy-only use better than any sentence in the justification.
8. **Settings → disconnect.** Show that access can be withdrawn.

---

## Submission order

0. **Set `ALLOWED_EMAILS` and confirm `inviteOnly: true`.** Everything
   below opens the door wider; this is what decides who walks through.
1. Buy the domain; point Cloudflare Pages at it.
2. Verify it in Search Console, using the Google account that owns the
   Cloud project.
3. Fill in the consent screen: app name, logo, support email, home page,
   privacy policy, authorized domain.
4. Switch publishing status to **Production**. *Do this even if you stop
   here* — it ends the 7-day refresh token expiry.
5. Record the video.
6. Submit for verification with the justifications above.

Expect days to weeks, and expect at least one round of questions.
Sensitive-scope reviews are less onerous than restricted ones, but they
are not instant.

---

## Keeping this honest

Three files have to agree, and nothing enforces it automatically:

- `webapp/src/lib/google-signin.ts` — the scopes actually requested
- `webapp/src/screens/Landing.tsx` — the Calendar section a reviewer reads
- `docs/privacy-policy.md` and `webapp/src/screens/Privacy.tsx` — the policy

A verification submission that describes behaviour the app does not have
is worse than no submission: it is the kind of mismatch that gets an
app's access revoked later, rather than merely rejected now.
