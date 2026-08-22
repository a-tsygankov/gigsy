# Google OAuth scopes — required vs requested

What Gigsy actually needs from Google, what it currently asks for, and
what can go. Every "required" line below is traced to the API call that
needs it, not to memory.

**The short version:** Gigsy asks for four scopes and needs four, but
one of them — `calendar.readonly` — is far broader than the job it does
and should be swapped for `calendar.freebusy`. Nothing needs removing
from the consent screen beyond that; the long list in the console is
scopes you *could* select because an API is enabled, not scopes you
have selected.

---

## 1. What Gigsy requests today

Verified in [`webapp/src/lib/google-signin.ts`](../webapp/src/lib/google-signin.ts).

| Scope | Asked for when | Category |
| --- | --- | --- |
| `openid` | Sign-in | Non-sensitive |
| `.../auth/userinfo.email` | Sign-in | Non-sensitive |
| `.../auth/userinfo.profile` | Sign-in | Non-sensitive |
| `.../auth/calendar.events` | Connecting Calendar in Settings | **Sensitive** |
| `.../auth/calendar.readonly` | Only when switching on "use my Google Calendar" for the availability page | **Sensitive** |

The full `.../auth/calendar` scope is **never** requested — worth stating
because `routes/calendar.ts` returns `{ scope: "calendar" }` in a 409
body, which looks like a scope request and is only an error label.

## 2. What each call actually requires

Gigsy touches exactly three Calendar endpoints
([`backend/src/calendar/google-calendar.ts`](../backend/src/calendar/google-calendar.ts)):

| Endpoint | Why | Narrowest scope that works |
| --- | --- | --- |
| `POST/PATCH/DELETE /calendars/{id}/events` | Write gigs onto the chosen calendar | `calendar.events`, or `calendar.events.owned` if the target is always a calendar the user owns |
| `POST /freeBusy` | Availability page | **`calendar.freebusy`** |
| `POST /calendars` | Create a dedicated "Gigsy" calendar | `calendar.app.created` (see §5 — this one is currently broken) |

Sign-in needs `openid` + `email`. `profile` comes along with the Google
Identity Services button whether or not it is wanted: the ID-token flow
(`google.accounts.id`) takes no scope parameter. Nothing in the codebase
reads `name` or `picture`, so it is unused — but not removable without
abandoning the standard sign-in button, which is not worth it.

## 3. The one real change: drop `calendar.readonly`

**`calendar.readonly` is the wrong scope for what Gigsy does with it.**
It grants "See and download **any** calendar you can access" — every
event title, description, location and guest list. Gigsy calls exactly
one endpoint with it, `POST /freeBusy`, which returns busy time ranges
and no event content at all.

`freebusy.query` accepts **four** scopes, per the
[API reference](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query):

- `calendar.readonly` ← what Gigsy uses
- `calendar` (broader still)
- `calendar.events.freebusy`
- **`calendar.freebusy`** — "View your availability in your calendars"

`calendar.freebusy` is the narrowest of the four and matches the use
exactly. Switching costs one constant in `google-signin.ts` and a
re-consent from anyone who has already enabled the feature.

> **Correction.** `docs/google-oauth-verification.md` previously argued
> that no narrower scope existed and that Google required
> `calendar.readonly` to call `freebusy`. That was wrong, and it was the
> justification most likely to be challenged — a reviewer looking at the
> same API reference would have refuted it in one line. Corrected there.

**Check the category badge in the console.** Google marks each scope
non-sensitive / sensitive / restricted automatically on the Data Access
screen. If `calendar.freebusy` is non-sensitive, this swap removes a
sensitive scope from the app outright and shortens any future
verification.

## 4. Sensitive scopes still required

After the swap, Gigsy still needs:

| Scope | Why it cannot be narrower |
| --- | --- |
| `calendar.events` | Writes gigs to a calendar the user picks, which defaults to `primary`. `calendar.app.created` covers only app-made calendars and cannot write to `primary`. `calendar.events.owned` would work *if* the target is always user-owned — a real narrowing candidate, but it breaks writing to a calendar shared with the user, so it needs a decision about whether that case matters. |
| `calendar.freebusy` (replacing `calendar.readonly`) | Only if the console marks it sensitive. It is the narrowest scope the `freeBusy` endpoint accepts either way. |

Neither is **restricted**, which is the expensive tier — restricted
scopes (Gmail, Drive) require an annual third-party CASA security
assessment. Calendar never reaches that.

## 5. A latent bug this turned up

"Create a dedicated Gigsy calendar" calls `POST /calendars`, which none
of the requested scopes permit. The API returns 403, the backend maps it
to `reconnect-required`, and the UI says:

> "Google needs broader permission to create a calendar. Disconnect and
> reconnect, then try again."

**Reconnecting cannot fix it.** The connect flow requests
`calendar.events` and nothing else, so the second attempt fails
identically. The advice sends the user in a circle.

The fix is a scope, not a message: request `calendar.app.created`
alongside `calendar.events` when the user asks for a dedicated calendar.
That scope exists precisely for this — "Make secondary Google calendars,
and see, create, change, and delete events on them" — and is narrower
than the alternatives (`calendar` or `calendar.calendars`).

## 6. What you can remove

### From the consent screen

**Probably nothing.** The table in the console's scope picker lists
every scope *selectable* because an API is enabled — it is a catalogue,
not a record of what you asked for. What matters is the list of
**selected** scopes on the Data Access screen.

Check there. It should contain exactly the five in §1. If it contains
anything else — a BigQuery or Logging scope that got ticked — remove it:
a scope on the consent screen is shown to users and reviewed by Google
whether or not the app ever uses it.

### From the project (APIs)

Only **Google Calendar API** is used. Every other API behind that list
is unused by Gigsy, which runs entirely on Cloudflare:

| Safe to disable | |
| --- | --- |
| Analytics Hub API | BigQuery API |
| BigQuery Data Transfer API | BigQuery Migration API |
| Cloud Dataplex API | Cloud Datastore API |
| Cloud Logging API | Cloud Monitoring API |
| Cloud Storage API | Cloud Trace API |
| Service Management API | |

Disable them at
[API Library → Enabled APIs](https://console.cloud.google.com/apis/dashboard?project=340454994892).

**This is tidiness, not security.** An enabled API grants nothing on its
own — access comes from scopes a user actually consents to. Disabling
shortens the picker and makes it harder to tick something by accident,
and that is the whole benefit. Most of these were enabled by default
when the project was created.

## 7. Actions, in order of value

1. **Swap `calendar.readonly` → `calendar.freebusy`.** Real privacy
   improvement, removes the weakest verification justification, and may
   drop a sensitive scope entirely. Requires re-consent from anyone
   already using the availability page.
2. **Add `calendar.app.created` to the dedicated-calendar flow.** Fixes
   a feature that currently cannot succeed and whose error message sends
   users in a circle.
3. **Check the Data Access screen** matches §1, and remove anything else.
4. **Disable the eleven unused APIs.** Cosmetic; do it when convenient.
5. **Consider `calendar.events.owned`** in place of `calendar.events` —
   only after deciding whether anyone needs to write gigs to a calendar
   someone else shared with them.
