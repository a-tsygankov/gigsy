# Gigsy — Privacy Policy

**Last updated: 10 August 2026**

> **This is a draft written from what the code actually does, not legal
> advice.** It is accurate to the implementation as of the date above,
> and it has not been reviewed by a lawyer. Google's OAuth verification
> requires a published privacy policy, so have this checked before you
> rely on it. Where it is wrong, the code is the source of truth —
> `docs/plan.md` and the Phase plans describe every data path named
> here.

Gigsy is a personal tracker for one-off gig work: the jobs you take, who
you take them for, what you are owed, and what you spend. It is built
for one person's own records.

## Who runs it

Gigsy is operated privately by its author. There is no company behind
it, and it is not sold. If you are reading this because you were invited
to try it, the person who invited you is the person who runs it.

## What is stored, and why

| Data | Why it exists |
|---|---|
| Your email address and Google account id | To sign you in and to keep your records separate from everyone else's |
| Gigs: client, title, date, duration, location, amounts, notes | The records the app exists to keep |
| Clients, expenses, payments, services | The same |
| Receipt and capture images | So an expense has its proof attached |
| Your settings | Working hours, timezone, reminder preferences, notification thresholds |
| An encrypted Google refresh token | So calendar sync can run when you are not using the app |
| Push subscription endpoints | Only if you turn notifications on |

Everything is scoped to your account. Every database query is filtered
by the user id from your verified session — that is the entire boundary
between your records and anyone else's.

## Your Google Calendar

Gigsy asks for calendar access separately from sign-in, and you can use
the app without granting it.

- **Writing** (`calendar.events`): confirmed gigs with a date become
  events on the calendar you choose. Leads never do. If you delete a
  gig, Gigsy deletes its event.
- **Reading** (`calendar.freebusy`): only if you switch on "use my
  Google Calendar" for the availability page. This permission grants
  your free/busy times and nothing else — it cannot show Gigsy event
  titles, descriptions, locations or attendees, because Google does not
  include them in what it returns. Those ranges are used to compute
  your free time and are then discarded. **They are never written to
  the database.**
- **Making a calendar** (`calendar.app.created`): only if you ask for a
  separate "Gigsy" calendar in Settings. It covers calendars this app
  creates and the events on them — it grants no access to any other
  calendar.

Gigsy never modifies or deletes an event it did not create.

## The shareable availability link

If you create one, anyone holding the link can see your free time, the
display name you chose, and your timezone — with no sign-in.

They cannot see who you work for, where, what you are paid, how many
gigs you have, or anything about your calendar. Booked time appears
only as a gap, and a gap caused by a gig is indistinguishable from one
caused by a dentist appointment or a day off.

The link is a random 128-bit token. Only a fingerprint of it is stored,
so it cannot be recovered or reissued — you can replace or switch it off
at any time, and doing so stops it working immediately.

## Who else your data reaches

Gigsy runs on Cloudflare and uses these third parties. Each one is
listed because data genuinely reaches it, not because it might.

| Service | What reaches it | When |
|---|---|---|
| **Cloudflare** (Workers, D1, R2, Pages, Email Routing) | Everything — it hosts the app and stores the database and images | Always |
| **Google** (Sign-In, Calendar) | Your email for sign-in; gig titles, locations, notes and times for events you sync | Sign-in, and calendar sync if connected |
| **Google Gemini** | The text of an email you forward, or the image you capture, for extraction | Only when you use capture |
| **Anthropic** | The same content, only if the Gemini extraction fails and a fallback is configured | Only when you use capture |
| **OpenStreetMap (Nominatim)** | Your coordinates, to turn "use my current location" into an address | Only when you tap that button |

**Capture content leaves Gigsy.** When you forward an email or take a
photo for automatic extraction, that content is sent to an AI provider
to be read. Do not forward anything you would not put into a third
party's system.

Gigsy does not use analytics, advertising, or tracking of any kind, and
it sells nothing to anyone.

## Security

- Sessions are short-lived signed tokens; the longer-lived refresh
  token is stored only as a hash and is replaced every time it is used,
  so a stolen one stops working.
- Your Google refresh token is encrypted at rest (AES-256-GCM).
- Availability link tokens are stored only as hashes.
- The public availability endpoint asks search engines not to index it
  and asks caches not to store it.

No system is perfectly secure, and this one is maintained by one person.
Judge it accordingly.

## Retention and deletion

Your records stay until you delete them. Deleting a gig, client,
expense or payment removes it from the database.

To remove your account and everything in it, ask the person who runs
Gigsy — there is no self-serve delete button yet. Disconnecting Google
Calendar in Settings erases the stored refresh token immediately.

Revoking Gigsy's access from your
[Google account permissions](https://myaccount.google.com/permissions)
stops all calendar access at once.

## Children

Gigsy is for adults tracking paid work. It is not intended for anyone
under 16.

## Changes

If this policy changes materially, the date at the top changes and
anyone using the app will be told.

## Contact

Questions, corrections, or a deletion request: contact the person who
invited you and runs this deployment.
