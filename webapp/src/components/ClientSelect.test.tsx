/** @vitest-environment jsdom */
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientSelect, NEW_CLIENT_OPTION, type ClientSelectProps } from "./ClientSelect.tsx";
import type { ClientChoice } from "../lib/client-choice.ts";
import type { Client } from "../lib/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ACME: Client = {
  id: "c1", name: "Acme", contactInfo: null, notes: null, needsDelivery: false, createdAt: 0, modifiedAt: 0,
};
const BRAVO: Client = {
  id: "c2", name: "Bravo", contactInfo: null, notes: null, needsDelivery: false, createdAt: 0, modifiedAt: 0,
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const byId = <T extends HTMLElement>(id: string): T | null =>
  container!.querySelector<T>(`[data-testid="${id}"]`);
const select = () => byId<HTMLSelectElement>("cs")!;
const nameBox = () => byId<HTMLInputElement>("cs-new-name");

/** Drive a native <select> the way React hears it: through the
 *  prototype's value setter, so React's change tracking does not
 *  swallow the event as a no-op (same device as GigEdit.test.tsx). */
async function choose(value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(select(), value);
    select().dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/**
 * The control is controlled, so a test that wants to see it CHANGE
 * (the box appearing, then collapsing) needs someone holding the value.
 * This harness does, and also records every emission so the tests can
 * assert the shapes.
 */
function Harness({
  initial,
  onChange,
  ...rest
}: { initial: ClientChoice; onChange: (next: ClientChoice) => void } & Partial<
  Omit<ClientSelectProps, "value" | "onChange">
>) {
  const [value, setValue] = useState<ClientChoice>(initial);
  return (
    <ClientSelect
      clients={[ACME, BRAVO]}
      testId="cs"
      value={value}
      onChange={(next) => {
        onChange(next);
        setValue(next);
      }}
      {...rest}
    />
  );
}

async function render(
  initial: ClientChoice,
  over: Partial<Omit<ClientSelectProps, "value" | "onChange">> = {},
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const onChange = vi.fn<(next: ClientChoice) => void>();
  await act(async () => {
    root!.render(<Harness initial={initial} onChange={onChange} {...over} />);
  });
  return onChange;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

describe("ClientSelect", () => {
  it("lists No client, every client, then New client…", async () => {
    await render({ kind: "none" });
    const options = [...select().options].map((o) => [o.value, o.textContent]);
    expect(options).toEqual([
      ["", "No client"],
      ["c1", "Acme"],
      ["c2", "Bravo"],
      [NEW_CLIENT_OPTION, "＋ New client…"],
    ]);
    expect(select().value).toBe("");
    expect(nameBox()).toBeNull();
  });

  it("uses the none label it is given", async () => {
    await render({ kind: "none" }, { noneLabel: "Anyone" });
    expect(select().options[0]?.textContent).toBe("Anyone");
  });

  it("shows an existing choice as the selected client, with no name box", async () => {
    await render({ kind: "existing", id: "c2" });
    expect(select().value).toBe("c2");
    expect(nameBox()).toBeNull();
  });

  it("emits existing for a client, and none for the empty option", async () => {
    const onChange = await render({ kind: "none" });
    await choose("c1");
    expect(onChange).toHaveBeenLastCalledWith({ kind: "existing", id: "c1" });
    await choose("");
    expect(onChange).toHaveBeenLastCalledWith({ kind: "none" });
  });

  it("opens a focused name box, with its hint, when New client… is chosen", async () => {
    const onChange = await render({ kind: "none" });
    await choose(NEW_CLIENT_OPTION);
    expect(onChange).toHaveBeenLastCalledWith({ kind: "new", name: "" });
    expect(nameBox()).not.toBeNull();
    expect(document.activeElement).toBe(nameBox());
    expect(byId("cs-new-hint")?.textContent).toBe("Saved with the gig");
    expect(select().value).toBe(NEW_CLIENT_OPTION);
  });

  it("emits new with the name as it is typed", async () => {
    const onChange = await render({ kind: "none" });
    await choose(NEW_CLIENT_OPTION);
    await type(nameBox()!, "Full Field Agency");
    expect(onChange).toHaveBeenLastCalledWith({ kind: "new", name: "Full Field Agency" });
    expect(nameBox()!.value).toBe("Full Field Agency");
  });

  it("collapses the name box when another option is chosen", async () => {
    const onChange = await render({ kind: "new", name: "Half typed" });
    expect(nameBox()).not.toBeNull();
    await choose("c1");
    expect(onChange).toHaveBeenLastCalledWith({ kind: "existing", id: "c1" });
    expect(nameBox()).toBeNull();
  });

  it("does not steal focus when it mounts already on New client", async () => {
    // DraftReview seeds `new` from a capture; the keyboard must not pop
    // over the photo on load. Only a CHOICE focuses the box.
    await render({ kind: "new", name: "ACME" });
    expect(nameBox()).not.toBeNull();
    expect(document.activeElement).not.toBe(nameBox());
  });

  it("disables the select and the name box together", async () => {
    await render({ kind: "new", name: "Acme" }, { disabled: true });
    expect(select().disabled).toBe(true);
    expect(nameBox()!.disabled).toBe(true);
  });

  it("names the select and the box off its label for a screen reader", async () => {
    await render({ kind: "new", name: "" }, { label: "Agency" });
    expect(select().getAttribute("aria-label")).toBe("Agency");
    expect(nameBox()!.getAttribute("aria-label")).toBe("Agency, new client name");
  });

  it("names an existing id the list does not hold, rather than showing No client", async () => {
    // A client matched at capture time that this device has not pulled
    // yet. A controlled <select> with no option for its value shows its
    // FIRST option — "No client" — while the state (and the save) still
    // carry the id. Seen live on 2026-09-19 against a client created
    // through the API a moment earlier.
    await render({ kind: "existing", id: "ghost" });
    expect(select().value).toBe("ghost");
    expect(select().options[select().selectedIndex]?.textContent).toBe(
      "A client this device hasn't loaded yet",
    );
    expect(byId("cs-unknown")).not.toBeNull();
  });

  it("offers no placeholder once the id is in the list", async () => {
    await render({ kind: "existing", id: ACME.id });
    expect(byId("cs-unknown")).toBeNull();
    expect(select().options[select().selectedIndex]?.textContent).toBe(ACME.name);
  });
});
