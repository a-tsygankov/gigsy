import { HelpTarget } from "../targets.ts";
import type { HelpScenario } from "../types.ts";

/**
 * Photographing a receipt or a flyer — the other half of capture.
 * `set-up-email-capture` covers the email route; this one covers the
 * camera, and the last step points at the other rather than repeating
 * it.
 *
 * EXECUTABLE, with one `external` step, the same shape as
 * `connect-calendar` and for the same reason: the button really is on
 * this screen and worth keeping under CI, while the thing it opens —
 * the OS camera / photo picker — is chrome no page can drive or
 * highlight.
 *
 * What this scenario deliberately does NOT do is touch `capture-input`.
 * That is the real `<input type="file" accept="image/*">`, it carries
 * `className="hidden"`, and it is not a target in targets.ts at all. An
 * `input` step against it would mean the help runner uploading a file
 * and the app creating a draft — a record — which is exactly what Phase
 * 13's rule forbids, on top of `performAction`'s `fill()` not being able
 * to set a file input in the first place. `capture-start`, the visible
 * <Button>, is the whole surface this scenario uses.
 *
 * Three of the four steps therefore anchor on that one button, and the
 * order is chronological rather than repetitive: press it, the device
 * takes over, you come back to this same screen with the button reading
 * "Reading the photo…", and then you land on the draft. The button is
 * genuinely the thing being explained at every one of those moments.
 *
 * The privacy step is deliberately the same sentence shape as
 * CaptureSection.tsx's own copy for the email route ("Anything you
 * forward is sent to an AI provider to be read, so it can pull out the
 * client, date and amount…"). Two different explanations of one fact
 * would be worse than either.
 *
 * No branch: Capture.tsx renders `capture-start` unconditionally. It is
 * disabled while offline or mid-upload, but disabled is not absent —
 * the target resolves and the spotlight lands either way, and the
 * offline case is explained in step one rather than branched on.
 */
export const captureReceipt: HelpScenario = {
  id: "capture-receipt",
  title: "Photograph a receipt or a flyer",
  description:
    "Snap it, Gigsy reads it, you check what it read — and nothing is created until you say so.",
  category: "capture",
  startRoute: "/capture",
  steps: [
    {
      action: "highlight",
      target: HelpTarget.CaptureStart,
      title: "Capture gig or receipt",
      description:
        "One button for both: it opens your camera if you want to shoot something now, or your photo library if you already have the picture. It works on a parking receipt, a booking sheet, a payment slip, or a flyer with a date and a fee on it — Gigsy works out which of those it's looking at. It needs a connection, because the reading happens on the server and not on your phone; offline, this button is greyed out and a note above says so.",
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
        "You land on a review screen with the photo at the top and every extracted field editable underneath — what it thinks this is, the client, the date, the amount. If the name matches a client you already have, it says which one; if it doesn't, it tells you a new client will be created. Confirm creates the gig (as a lead), the expense, or the payment — for a payment slip, the same photo becomes its proof automatically, no second upload; Later leaves the draft on your Drafts list; Discard throws it away. Until you press Confirm, nothing exists. If the reading fails outright you're told here instead, and no draft is made at all — the photo is worth retaking in better light. Prefer email? \"Forward a booking email\" is the same machinery by the other road.",
    },
  ],
};
