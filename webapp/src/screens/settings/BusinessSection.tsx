/**
 * Who the invoice is FROM, and how it is numbered.
 *
 * None of this affects the app's own behaviour — it exists to be
 * printed on a document that goes to somebody else. That is why every
 * field is optional: a user who never invoices should not be nagged,
 * and one who does gets told what is missing on the invoice itself
 * rather than being blocked here.
 *
 * Free text is a first for this screen. Every other section is selects
 * and toggles, which commit on change; committing an address on change
 * would queue a settings PATCH per keystroke, so these commit on blur.
 */
import { useEffect, useState } from "react";
import { Input, SettingGroup, SettingRow, Textarea } from "../../components/index.ts";
import { useSettings } from "./useSettings.ts";

/** Local draft that follows the stored value until the user types.
 *  Without this, an optimistic settings write would rewrite the box
 *  under the cursor. */
function useDraft(stored: string | null): [string, (v: string) => void] {
  const [draft, setDraft] = useState(stored ?? "");
  useEffect(() => setDraft(stored ?? ""), [stored]);
  return [draft, setDraft];
}

export function BusinessSection() {
  const { settings, update, isSaving } = useSettings();
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
   *  The key is a union, not `string`: `update({ [key]: … })` with a
   *  `string` key widens to `{ [x: string]: string | null }`, which is
   *  not assignable to `Partial<Settings>` — it would have to satisfy
   *  `invoiceNextNumber?: number` too. */
  type TextField =
    | "businessName"
    | "businessAddress"
    | "businessContact"
    | "businessTaxId"
    | "businessPaymentDetails";

  const commit = (key: TextField, value: string): void => {
    const trimmed = value.trim();
    update({ [key]: trimmed === "" ? null : trimmed });
  };

  return (
    <SettingGroup title="Business details" data-testid="settings-business">
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
            disabled={isSaving}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => commit("businessName", name)}
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
            maxLength={400}
            rows={3}
            value={address}
            disabled={isSaving}
            onChange={(e) => setAddress(e.target.value)}
            onBlur={() => commit("businessAddress", address)}
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
            disabled={isSaving}
            onChange={(e) => setContact(e.target.value)}
            onBlur={() => commit("businessContact", contact)}
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
            disabled={isSaving}
            onChange={(e) => setTaxId(e.target.value)}
            onBlur={() => commit("businessTaxId", taxId)}
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
            maxLength={600}
            rows={3}
            value={payment}
            disabled={isSaving}
            onChange={(e) => setPayment(e.target.value)}
            onBlur={() => commit("businessPaymentDetails", payment)}
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
            disabled={isSaving}
            onChange={(e) => setNumber(e.target.value)}
            // On blur, like the text fields above and for the same
            // reason: committing on change is a settings PATCH per
            // keystroke, so typing "1024" would write 1, then 10, then
            // 102. An out-of-range value is discarded rather than sent,
            // because the server bounds this at 1..9,999,999 and a 400
            // here would silently roll the counter back.
            onBlur={() => {
              const n = Number(number);
              if (Number.isInteger(n) && n >= 1 && n <= 9_999_999) {
                update({ invoiceNextNumber: n });
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
            disabled={isSaving}
            onChange={(e) => setTerms(e.target.value)}
            onBlur={() => {
              const n = Number(terms);
              if (Number.isInteger(n) && n >= 1 && n <= 365) {
                update({ invoicePaymentTermsDays: n });
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
