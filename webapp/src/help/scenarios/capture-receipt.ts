import { HelpTarget } from "../targets.ts";
import type { HelpScenario } from "../types.ts";

/**
 * Capturing a receipt, a flyer or a booking sheet — the other half of
 * capture. `set-up-email-capture` covers the email route; this one
 * covers the file chooser and the camera, and the last step points at
 * the other rather than repeating it.
 *
 * EXECUTABLE, with one `external` step, the same shape as
 * `connect-calendar` and for the same reason: both controls really are
 * on this screen and worth keeping under CI, while the thing they open
 * — the OS file sheet or camera — is chrome no page can drive or
 * highlight.
 *
 * Two controls on the screen now (Capture.tsx, and docs/superpowers/
 * specs/2026-09-18-gig-batches-design.md): `capture-input` is the
 * VISIBLE native file chooser (a `FilePicker`), which the OS turns into
 * "camera / library / files", and `capture-start` is the "Take a photo"
 * button over a hidden camera-only input. The chooser is spotlightable
 * and step one highlights it. What this scenario still does NOT do is
 * DRIVE it: an `input` step against a file input would mean the help
 * runner uploading a file and the app creating a draft — a record —
 * which is exactly what Phase 13's rule forbids, on top of
 * `performAction`'s `fill()` not being able to set a file input in the
 * first place. Every step here is a highlight or an external.
 *
 * The order is chronological rather than repetitive: choose or shoot,
 * the device takes over, you come back to this same screen with the
 * button reading "Reading the photo…", and then you land on the draft.
 *
 * The privacy step is deliberately the same sentence shape as
 * CaptureSection.tsx's own copy for the email route ("Anything you
 * forward is sent to an AI provider to be read, so it can pull out the
 * client, date and amount…"). Two different explanations of one fact
 * would be worse than either.
 *
 * No branch: Capture.tsx renders both controls unconditionally. They
 * are disabled while offline or mid-upload, but disabled is not absent
 * — the targets resolve and the spotlight lands either way, and the
 * offline case is explained in step one rather than branched on.
 */
export const captureReceipt: HelpScenario = {
  id: "capture-receipt",
  title: "Capture a receipt, a flyer or a booking sheet",
  description:
    "Pick a file or snap it, Gigsy reads it, you check what it read — and nothing is created until you say so.",
  category: "capture",
  startRoute: "/capture",
  steps: [
    {
      action: "highlight",
      target: HelpTarget.CaptureFile,
      title: "Choose a photo or file",
      description:
        "Tap this to pick something you already have: a picture from your photo library, a file someone sent you, or a PDF booking sheet — on a phone the same sheet offers the camera too. It works on a parking receipt, a booking sheet, a payment slip, or a flyer with a date and a fee on it — Gigsy works out which of those it's looking at. Anything over 8 MB is refused here, while you can still pick again. It needs a connection, because the reading happens on the server and not on your phone; offline, both controls are greyed out and a note above says so.",
    },
    {
      action: "highlight",
      target: HelpTarget.CaptureStart,
      title: "Take a photo",
      description:
        "The camera and nothing else, for when the flyer is on the wall in front of you. Same reading, same review afterwards — the only difference from the chooser above is that this one skips the sheet and opens the camera straight away.",
    },
    {
      action: "external",
      externalType: "os-ui",
      title: "Your device takes over",
      description:
        "What opens next belongs to your phone or computer, not to Gigsy — no part of this app can highlight it, choose for you, or see what you picked. Frame the whole receipt, corners included, and let it be readable; a photo of half a total gives you a draft with half a total in it. Back out of the picker and nothing at all happens.",
    },
    {
      action: "highlight",
      target: HelpTarget.CaptureStart,
      title: "Where the photo goes",
      description:
        "As soon as you pick one, this button reads \"Reading the photo…\" and the image is uploaded and sent to an AI provider to be read, so it can pull out the client, date and amount. Don't photograph anything you wouldn't put into someone else's system — the receipt, not the card that paid for it. The original image is kept, so you can check what was extracted against it, and it stays with the draft rather than being thrown away once it's read. Same provider, same terms as forwarding an email, and the two share one daily limit on readings.",
    },
    {
      action: "highlight",
      target: HelpTarget.CaptureStart,
      title: "Nothing exists until you confirm",
      description:
        "You land on a review screen with the photo at the top and a \"This is a…\" choice — gig, expense, or payment — with only the fields that kind needs editable underneath: client, date and offered amount for a gig; amount and category for an expense; amount and when it was received for a payment. Only for a gig does it also say whether the client name matches one you already have, or tells you a new one will be created. A booking sheet that lists several dates shows the first as the date and the rest as \"Also on\" rows you can edit, add to or remove — Confirm then creates one gig per date, each a copy of the rest, all linked as created together. Confirm creates the gig (as a lead), the expense, or the payment — for a payment, the same photo usually becomes its proof with no second upload, though a storage hiccup can leave that for you to attach afterward instead; Later leaves the draft on your Drafts list; Discard throws it away. Until you press Confirm, nothing exists. If the reading fails outright you're told here instead, and no draft is made at all — the photo is worth retaking in better light. Prefer email? \"Forward a booking email\" is the same machinery by the other road.",
    },
  ],
};
