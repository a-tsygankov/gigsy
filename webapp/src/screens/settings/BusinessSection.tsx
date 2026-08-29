/**
 * Who the invoice is FROM, and how it is numbered.
 *
 * The five business-detail strings don't affect the app's own
 * behaviour — they exist to be printed on a document that goes to
 * somebody else, which is why they're all optional: a user who never
 * invoices should not be nagged, and one who does gets told what's
 * missing on the invoice itself rather than being blocked here. The
 * two counters are different: `invoicePaymentTermsDays` sets the
 * invoice's due date and `invoiceNextNumber` is a counter the app
 * increments on its own, so neither is nullable.
 *
 * Free text already exists on this screen — AvailabilitySection's name
 * field commits on blur for the same reason these do: committing on
 * change would queue a settings PATCH per keystroke, and the selects
 * and toggles elsewhere don't have that problem because the control
 * itself IS the value.
 */
import { useEffect, useState } from "react";
import { Input, SettingGroup, SettingRow, Textarea } from "../../components/index.ts";
import { useSettings } from "./useSettings.ts";

/** Local draft that mirrors the stored value on every render — the
 *  effect has no notion of "typing" and keeps mirroring forever, not
 *  just until the first keystroke. It stays safe under an unrelated
 *  optimistic write only because `stored` is a primitive: a write to
 *  some other field leaves this one's value unchanged, so the
 *  dependency compares equal and the effect does not re-fire mid-edit. */
function useDraft(stored: string | null): [string, (v: string) => void] {
  const [draft, setDraft] = useState(stored ?? "");
  useEffect(() => setDraft(stored ?? ""), [stored]);
  return [draft, setDraft];
}

export function BusinessSection() {
  const { settings, update } = useSettings();
  const [name, setName] = useDraft(settings?.businessName ?? null);
  const [address, setAddress] = useDraft(settings?.businessAddress ?? null);
  const [contact, setContact] = useDraft(settings?.businessContact ?? null);
  const [taxId, setTaxId] = useDraft(settings?.businessTaxId ?? null);
  const [payment, setPayment] = useDraft(settings?.businessPaymentDetails ?? null);
  // The two counters are drafts as well, so typing "1024" is not four
  // settings writes. `useDraft` takes a string, so they are stringified
  // on the way in and parsed on blur.
  const [number, setNumber] = useDraft(
    settings === undefined ? null : String(settings.invoiceNextNumber),
  );
  const [terms, setTerms] = useDraft(
    settings === undefined ? null : String(settings.invoicePaymentTermsDays),
  );

  if (settings === undefined) return null;

  /** "" is not a value the server will take — every one of these is
   *  `.min(1).nullable()`, so an emptied box means null.
   *
   *  The key is a union, not `string`: a plain `string` would let a
   *  typo'd key compile, and the only place it would show up is a 400
   *  from the server's `.strict()` patch schema — which `useSettings`'s
   *  optimistic `onError` then rolls back silently, same as an
   *  over-length value. The union catches the typo at compile time
   *  instead. */
  type TextField =
    | "businessName"
    | "businessAddress"
    | "businessContact"
    | "businessTaxId"
    | "businessPaymentDetails";

  /** `setDraft` writes the canonical (trimmed) value back to the box
   *  regardless of whether a PATCH goes out, so " Tsygankov Ltd " reads
   *  back as "Tsygankov Ltd" rather than sitting there untrimmed —
   *  `useDraft`'s mirror effect only fires when the STORED value
   *  changes, so a no-op write (canonical already matches stored) would
   *  otherwise leave the box disagreeing with the server forever.
   *
   *  The comparison against `settings[key]` also means tabbing through
   *  every field without editing any of them sends zero PATCHes,
   *  instead of one per field blurred. */
  const commit = (key: TextField, value: string, setDraft: (v: string) => void): void => {
    const trimmed = value.trim();
    const canonical = trimmed === "" ? null : trimmed;
    setDraft(canonical ?? "");
    if (canonical === (settings[key] ?? null)) return;
    update({ [key]: canonical });
  };

  return (
    <SettingGroup title="Business details" data-testid="settings-business">
      {/* None of the controls below are `disabled={isSaving}`, unlike
          GigDefaultsSection's selects. A select IS the value, so a
          second click racing an in-flight write is a real bug the
          disable prevents. These commit on blur, and disabling the
          group mid-commit fights the user's next action: type in
          Business name, click into Address, and the click's focus
          triggers Name's blur, which sets isSaving before Address ever
          receives it — Address renders disabled, the browser blurs it
          right back out, and whatever was about to be typed there has
          nowhere to land. The write is optimistic, so there is nothing
          worth waiting for. */}
      <SettingRow
        label="Business name"
        description="Printed at the top of every invoice. Your own name is fine."
        htmlFor="set-business-name"
        control={
          <Input
            id="set-business-name"
            data-testid="business-name"
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => commit("businessName", name, setName)}
          />
        }
      />
      <SettingRow
        label="Address"
        description="Your postal address, as it should appear on the invoice."
        htmlFor="set-business-address"
        control={
          <Textarea
            id="set-business-address"
            data-testid="business-address"
            className="sm:w-56"
            maxLength={400}
            rows={3}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onBlur={() => commit("businessAddress", address, setAddress)}
          />
        }
      />
      <SettingRow
        label="Contact"
        description="Email or phone — how the client reaches you about this bill."
        htmlFor="set-business-contact"
        control={
          <Input
            id="set-business-contact"
            data-testid="business-contact"
            maxLength={200}
            value={contact}
            onChange={(e) => setContact(e.target.value)}
            onBlur={() => commit("businessContact", contact, setContact)}
          />
        }
      />
      <SettingRow
        label="Tax / VAT number"
        description="Printed as text. Gigsy does not calculate tax."
        htmlFor="set-business-taxid"
        control={
          <Input
            id="set-business-taxid"
            data-testid="business-taxid"
            maxLength={120}
            value={taxId}
            onChange={(e) => setTaxId(e.target.value)}
            onBlur={() => commit("businessTaxId", taxId, setTaxId)}
          />
        }
      />
      <SettingRow
        label="Payment details"
        description="Bank account, IBAN, or however you want to be paid."
        htmlFor="set-business-payment"
        control={
          <Textarea
            id="set-business-payment"
            data-testid="business-payment"
            className="sm:w-56"
            maxLength={600}
            rows={3}
            value={payment}
            onChange={(e) => setPayment(e.target.value)}
            onBlur={() => commit("businessPaymentDetails", payment, setPayment)}
          />
        }
      />
      <SettingRow
        label="Next invoice number"
        description="Counts up on its own. Change it if you are continuing a sequence from elsewhere."
        htmlFor="set-invoice-number"
        control={
          <Input
            id="set-invoice-number"
            data-testid="invoice-next-number"
            type="number"
            min={1}
            max={9999999}
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            // On blur, like the text fields above and for the same
            // reason: committing on change is a settings PATCH per
            // keystroke, so typing "1024" would write 1, then 10, then
            // 102. An out-of-range value is discarded rather than sent,
            // because the server bounds this at 1..9,999,999 and a 400
            // here would silently roll the counter back. The box is
            // always reset to a canonical value — "007" back to "7", or
            // an invalid entry back to whatever the server has — so it
            // never sits disagreeing with the last thing that actually
            // saved.
            onBlur={() => {
              const n = Number(number);
              if (Number.isInteger(n) && n >= 1 && n <= 9_999_999) {
                setNumber(String(n));
                if (n !== settings.invoiceNextNumber) update({ invoiceNextNumber: n });
              } else {
                setNumber(String(settings.invoiceNextNumber));
              }
            }}
          />
        }
      />
      <SettingRow
        label="Payment terms (days)"
        description="How long the client has to pay. Sets the due date on the invoice."
        htmlFor="set-invoice-terms"
        control={
          <Input
            id="set-invoice-terms"
            data-testid="invoice-terms-days"
            type="number"
            min={1}
            max={365}
            value={terms}
            onChange={(e) => setTerms(e.target.value)}
            onBlur={() => {
              const n = Number(terms);
              if (Number.isInteger(n) && n >= 1 && n <= 365) {
                setTerms(String(n));
                if (n !== settings.invoicePaymentTermsDays) update({ invoicePaymentTermsDays: n });
              } else {
                setTerms(String(settings.invoicePaymentTermsDays));
              }
            }}
          />
        }
      />
    </SettingGroup>
  );
}
