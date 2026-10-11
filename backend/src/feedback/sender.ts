/**
 * How feedback mail leaves the Worker — behind an interface, the way
 * capture/extraction.ts puts the model behind `ExtractionProvider`.
 *
 * The route (routes/feedback.ts) never touches the `send_email`
 * binding directly. It asks a factory for an `EmailSender` and either
 * gets one or gets null, and tests inject a recorder, a thrower, or a
 * factory that returns nothing — the three outcomes the row's
 * `email_status` has to tell apart (sent / failed / unsent). Keeping
 * the binding's own shape in one function here also means the day
 * Email Sending changes its builder fields, there is one place to
 * change (docs/superpowers/specs/2026-10-11-feedback-design.md).
 */
import type { Bindings, SendEmailBinding } from "../env.ts";

export interface OutgoingAttachment {
  filename: string;
  type: string;
  content: ArrayBuffer;
}

export interface OutgoingEmail {
  from: string;
  to: string[];
  subject: string;
  text: string;
  attachments: OutgoingAttachment[];
}

export interface EmailSender {
  /** Rejects when the message could not be handed over; resolves with
   *  the platform's id when it was. The route turns the two into
   *  `failed` and `sent`. */
  send(message: OutgoingEmail): Promise<{ messageId: string }>;
}

/** The real thing: forwards to a `[[send_email]]` binding. */
export function cloudflareSender(binding: SendEmailBinding): EmailSender {
  return {
    async send(message) {
      const result = await binding.send({
        from: message.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        // Every image goes as a plain attachment, never inline: the
        // body is text, so there is nothing for an inline part to be
        // referenced from, and an admin's mail client lists plain
        // attachments where they can be opened and saved.
        attachments: message.attachments.map((a) => ({
          disposition: "attachment" as const,
          filename: a.filename,
          type: a.type,
          content: a.content,
        })),
      });
      return { messageId: result.messageId };
    },
  };
}

export type SenderFactory = (env: Bindings) => EmailSender | null;

/**
 * null when the deployment has no `EMAIL` binding — which is every
 * deployment until the operator onboards a sending domain and adds the
 * block wrangler.toml keeps commented out. The route reads null as
 * "store it, mark it unsent, say so in the log"; nothing throws.
 */
export function senderFromEnv(env: Bindings): EmailSender | null {
  return env.EMAIL === undefined ? null : cloudflareSender(env.EMAIL);
}
