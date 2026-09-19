/**
 * The client field on a gig — every client, "No client", and one more
 * option that is not a client at all: "＋ New client…", which opens a
 * name box under the select (design system, components/core/
 * ClientSelect; docs/superpowers/specs/2026-09-19-client-create-and-
 * match-design.md).
 *
 * Adding a gig for a client that does not exist yet used to mean
 * leaving the form, adding the client, coming back and starting over.
 * The name is typed here instead, and the client is created when the
 * gig is saved — not when the option is picked, so a form that is then
 * cancelled leaves no orphan on the Clients tab. That is why this
 * control emits a `ClientChoice` (lib/client-choice.ts) rather than an
 * id: `new` is an intent the SCREEN resolves at save through
 * `resolveClientChoice`, and this control never writes anything.
 *
 * It stays a native `<select>` on purpose. The design system reserves
 * `<select>` for short, fixed vocabularies and gives records the
 * `GigPicker` sheet — but a person's client list is short (a handful
 * of agencies, not a hundred gigs), it was a select before this, and
 * what is added is one action at the end, which is what a select's
 * last option is for. `GigPicker` would be a full-screen search for
 * six names.
 *
 * Deliberately dumb about validity: a `new` choice with a blank name
 * is emitted as typed and refused by the screen at save ("Give the new
 * client a name."), because a name box that complains while you are
 * still typing is a box you cannot use. Used by GigEdit.tsx and
 * DraftReview.tsx.
 */
import { useEffect, useRef } from "react";
import type { Client } from "../lib/types.ts";
import type { ClientChoice } from "../lib/client-choice.ts";
import { Input } from "./Input.tsx";
import { Select } from "./Select.tsx";

/** The `<option>` value that stands for "＋ New client…". Two
 *  underscores each side so it can never collide with a client id
 *  (UUIDs) or with "" (No client). */
export const NEW_CLIENT_OPTION = "__new__";

export interface ClientSelectProps {
  clients: readonly Client[];
  value: ClientChoice;
  onChange: (next: ClientChoice) => void;
  /** The `<select>`'s id. The name box is `${testId}-new-name` and the
   *  hint under it `${testId}-new-hint`. */
  testId: string;
  /** Spoken name for the select. `Field` wraps its children in a
   *  `<label>` that names only the FIRST control inside it, which is
   *  the select; the name box names itself off this ("Client, new
   *  client name") so a screen reader hears what the box is for. */
  label?: string;
  /** What the empty option says. "No client" on both screens so far. */
  noneLabel?: string;
  disabled?: boolean;
}

function selectValue(choice: ClientChoice): string {
  switch (choice.kind) {
    case "none":
      return "";
    case "existing":
      return choice.id;
    case "new":
      return NEW_CLIENT_OPTION;
  }
}

function choiceFor(optionValue: string): ClientChoice {
  if (optionValue === "") return { kind: "none" };
  if (optionValue === NEW_CLIENT_OPTION) return { kind: "new", name: "" };
  return { kind: "existing", id: optionValue };
}

export function ClientSelect({
  clients,
  value,
  onChange,
  testId,
  label = "Client",
  noneLabel = "No client",
  disabled = false,
}: ClientSelectProps) {
  /** The block that holds the name box. `Input` is a plain function
   *  component (no `forwardRef`), so the box is reached through its
   *  wrapper rather than by a ref of its own. */
  const nameBlock = useRef<HTMLDivElement>(null);
  const wasNew = useRef(value.kind === "new");

  /**
   * Focus the name box when it APPEARS after a choice — the next thing
   * anyone does after picking "New client…" is type the name, and on a
   * phone that means the keyboard should already be up.
   *
   * A transition, not `autoFocus`: DraftReview mounts this control
   * already on `new` when a capture named a client nothing matched,
   * and grabbing focus on page load there would pop the keyboard over
   * the photo the person came to check. So the box takes focus only
   * when the value BECOMES `new`, never when it starts that way.
   */
  useEffect(() => {
    const isNew = value.kind === "new";
    if (isNew && !wasNew.current) nameBlock.current?.querySelector("input")?.focus();
    wasNew.current = isNew;
  }, [value.kind]);

  return (
    <div>
      <Select
        data-testid={testId}
        aria-label={label}
        value={selectValue(value)}
        disabled={disabled}
        onChange={(e) => onChange(choiceFor(e.target.value))}
      >
        <option value="">{noneLabel}</option>
        {clients.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
        {/* A chosen id the list does not hold — a client matched at
            capture time that this device has not pulled yet, or one
            deleted since. A controlled <select> whose value matches no
            option silently shows its FIRST option, so the box would
            read "No client" while the state still held the id and the
            save sent it (GigEdit.tsx's client-change effect exists for
            that very trap). Naming it keeps what is shown and what is
            saved the same thing. Same wording as GigPicker's. */}
        {value.kind === "existing" && !clients.some((c) => c.id === value.id) && (
          <option value={value.id} data-testid={`${testId}-unknown`}>
            A client this device hasn't loaded yet
          </option>
        )}
        <option value={NEW_CLIENT_OPTION}>＋ New client…</option>
      </Select>
      {value.kind === "new" && (
        <div ref={nameBlock} className="mt-2">
          <Input
            data-testid={`${testId}-new-name`}
            aria-label={`${label}, new client name`}
            placeholder="Client name"
            maxLength={200}
            value={value.name}
            disabled={disabled}
            onChange={(e) => onChange({ kind: "new", name: e.target.value })}
          />
          <span
            data-testid={`${testId}-new-hint`}
            className="mt-1 block text-xs text-slate-500"
          >
            Saved with the gig
          </span>
        </div>
      )}
    </div>
  );
}
