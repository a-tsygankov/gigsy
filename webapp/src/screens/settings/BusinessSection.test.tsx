/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BusinessSection } from "./BusinessSection.tsx";

const update = vi.fn();
let settings: Record<string, unknown> | undefined;

vi.mock("./useSettings.ts", () => ({
  useSettings: () => ({ settings, update, isSaving: false }),
}));

// react-dom's own `act` warns without this. Same setup as
// HelpProvider.test.tsx, which explains why it is not a global.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  update.mockReset();
  settings = {
    businessName: "Tsygankov Ltd",
    businessAddress: null,
    businessContact: null,
    businessTaxId: null,
    businessPaymentDetails: null,
    invoiceNextNumber: 7,
    invoicePaymentTermsDays: 14,
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = () => act(() => root.render(<BusinessSection />));
const field = (id: string) =>
  container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-testid="${id}"]`);
// React tracks controlled fields off the native value setter, not a
// plain `.value =` assignment — same reason WorkCard.test.tsx and
// DateTimeField.test.tsx write through the prototype setter. Setting
// `.value` directly goes through React's own overridden setter on a
// controlled node, which updates its internal tracker too, so the
// following "input" event looks like a no-op and never reaches
// onChange.
function type(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  act(() => el.dispatchEvent(new Event("input", { bubbles: true })));
}
// React 17+ listens for the bubbling "focusout", not "blur" — see the
// same helper in screens/gigs/WorkCard.test.tsx. A plain "blur" event
// never reaches onBlur, so the field would look stuck on every commit.
const blur = (el: HTMLElement) =>
  act(() => el.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));

const ALL_FIELD_IDS = [
  "business-name",
  "business-address",
  "business-contact",
  "business-taxid",
  "business-payment",
  "invoice-next-number",
  "invoice-terms-days",
];

describe("BusinessSection", () => {
  it("renders nothing until settings have loaded", () => {
    settings = undefined;
    render();
    expect(container.textContent).toBe("");
  });

  it("shows the stored values", () => {
    render();
    expect(field("business-name")?.value).toBe("Tsygankov Ltd");
    expect(field("invoice-next-number")?.value).toBe("7");
  });

  it("patches a text field on blur, not on every keystroke", () => {
    // Committing on change would queue a settings PATCH per character
    // of an address; this and AvailabilitySection's name field are the
    // only free-text controls on the screen, and both commit on blur
    // for that reason.
    render();
    const name = field("business-name")!;
    type(name, "New Name");
    expect(update).not.toHaveBeenCalled();
    blur(name);
    expect(update).toHaveBeenCalledWith({ businessName: "New Name" });
  });

  it("stores an emptied field as null, not an empty string", () => {
    // The server bounds these with `.min(1)`, so "" is a 400. Absent
    // means null.
    render();
    const name = field("business-name")!;
    type(name, "");
    blur(name);
    expect(update).toHaveBeenCalledWith({ businessName: null });
  });

  it("does not write anything when a field is blurred untouched", () => {
    // Tabbing through the whole section without editing anything used
    // to fire one PATCH per field. Blurring every field here, with no
    // typing in between, must produce zero writes.
    render();
    for (const id of ALL_FIELD_IDS) blur(field(id)!);
    expect(update).not.toHaveBeenCalled();
  });

  describe("invoice-next-number", () => {
    it("resets an emptied box without writing", () => {
      render();
      const box = field("invoice-next-number")!;
      type(box, "");
      blur(box);
      expect(update).not.toHaveBeenCalled();
      expect(box.value).toBe("7");
    });

    it("rejects an out-of-range value without writing", () => {
      render();
      const box = field("invoice-next-number")!;
      type(box, "99999999");
      blur(box);
      expect(update).not.toHaveBeenCalled();
      expect(box.value).toBe("7");
    });

    it("commits a valid value as a number, not the drafted string", () => {
      render();
      const box = field("invoice-next-number")!;
      type(box, "12");
      blur(box);
      expect(update).toHaveBeenCalledWith({ invoiceNextNumber: 12 });
    });
  });

  describe("invoice-terms-days", () => {
    it("commits a valid value as a number", () => {
      render();
      const box = field("invoice-terms-days")!;
      type(box, "30");
      blur(box);
      expect(update).toHaveBeenCalledWith({ invoicePaymentTermsDays: 30 });
    });
  });
});
