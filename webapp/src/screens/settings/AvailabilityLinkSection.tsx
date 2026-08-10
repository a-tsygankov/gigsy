/**
 * Sharing an availability link (Phase 12, Task 5).
 *
 * Two things this screen has to get right, and they pull against each
 * other. The link must be easy to hand to an agency, and the user must
 * understand what they are handing over — because someone who does not
 * trust the boundary will not use the feature at all, and someone who
 * trusts it wrongly has been let down by us.
 *
 * The one-shot reveal is not a design choice made here; it falls out of
 * storing only a hash (Task 2). Nothing on the server can reproduce the
 * token, so this is the only moment it exists. The copy says so plainly
 * rather than letting someone navigate away and come back for it.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useData } from "../../lib/app-context.tsx";
import { Button, SettingGroup, SettingRow } from "../../components/index.ts";

const LINK_KEY = ["availability-link"] as const;

/** Offered expiries. "A link sent to an agency in March should not
 *  still work in December unless you said so" — but saying so is the
 *  user's call, so never is a real option rather than a trap. */
const EXPIRY_CHOICES = [
  { value: null, label: "Never expires" },
  { value: 30, label: "Expires in 30 days" },
  { value: 90, label: "Expires in 90 days" },
  { value: 365, label: "Expires in a year" },
];

function formatDate(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(ms));
}

export function AvailabilityLinkSection() {
  const data = useData();
  const queryClient = useQueryClient();
  /** Held in memory only, and only until the next navigation. */
  const [revealed, setRevealed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [expiresInDays, setExpiresInDays] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const link = useQuery({
    queryKey: LINK_KEY,
    queryFn: () => data.getAvailabilityLink(),
  });

  const create = useMutation({
    mutationFn: () => data.createAvailabilityLink(expiresInDays),
    onSuccess: (made) => {
      setNotice(null);
      setCopied(false);
      setRevealed(`${window.location.origin}${made.path}`);
      void queryClient.invalidateQueries({ queryKey: LINK_KEY });
    },
    onError: () => setNotice("Couldn't create the link. Check your connection."),
  });

  const revoke = useMutation({
    mutationFn: () => data.revokeAvailabilityLink(),
    onSuccess: () => {
      setRevealed(null);
      setNotice("That link no longer works for anyone who has it.");
      void queryClient.invalidateQueries({ queryKey: LINK_KEY });
    },
    onError: () => setNotice("Couldn't turn the link off. Try again."),
  });

  const active = link.data?.active ?? null;
  const busy = create.isPending || revoke.isPending;

  return (
    <SettingGroup
      title="Shareable link"
      description="One link that shows when you're free, and nothing else."
      data-testid="settings-availability-link"
    >
      {/* Stated before the link is made, not after. Someone deciding
          whether to share this needs it now. */}
      <div className="py-3">
        <p className="text-xs text-slate-500">
          Anyone with the link sees your free time, the name you choose, and
          your timezone. They cannot see who you work for, where, what you're
          paid, or how many gigs you have — booked time appears only as a gap.
          No sign-in, and search engines are asked to stay away.
        </p>
      </div>

      {revealed !== null && (
        <div className="py-3" data-testid="availability-link-revealed">
          <p className="text-xs font-medium text-amber-700">
            Copy this now — it can't be shown again. Only a fingerprint of it is
            stored, so if you lose it you'll need to make a new one.
          </p>
          <p
            className="mt-2 select-all break-all rounded-xl bg-slate-200 px-3 py-2 font-mono text-xs text-slate-700"
            data-testid="availability-link-value"
          >
            {revealed}
          </p>
          <Button
            variant="soft"
            className="mt-2"
            data-testid="availability-link-copy"
            onClick={() => {
              void navigator.clipboard
                .writeText(revealed)
                .then(() => setCopied(true))
                // Clipboard access can be refused; the text above is
                // select-all for exactly this case.
                .catch(() => setNotice("Couldn't copy — select the link above."));
            }}
          >
            {copied ? "Copied" : "Copy link"}
          </Button>
        </div>
      )}

      {link.isPending ? (
        <p className="py-3 text-xs text-slate-400">Loading…</p>
      ) : active === null ? (
        <SettingRow
          label="Create a link"
          description="Nothing is shared until you make one."
          htmlFor="set-link-expiry"
          control={
            <div className="flex flex-col items-stretch gap-2 sm:items-end">
              <select
                id="set-link-expiry"
                data-testid="select-link-expiry"
                className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-base text-slate-900"
                value={String(expiresInDays)}
                disabled={busy}
                onChange={(e) =>
                  setExpiresInDays(e.target.value === "null" ? null : Number(e.target.value))
                }
              >
                {EXPIRY_CHOICES.map((c) => (
                  <option key={String(c.value)} value={String(c.value)}>
                    {c.label}
                  </option>
                ))}
              </select>
              <Button
                variant="soft"
                data-testid="availability-link-create"
                disabled={busy}
                onClick={() => create.mutate()}
              >
                {create.isPending ? "Creating…" : "Create link"}
              </Button>
            </div>
          }
        />
      ) : (
        <>
          <SettingRow
            label="Link is live"
            description={
              active.expiresAt === null
                ? `Made ${formatDate(active.createdAt)}. It doesn't expire on its own.`
                : `Made ${formatDate(active.createdAt)}. Stops working ${formatDate(active.expiresAt)}.`
            }
            control={
              <span
                className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700"
                data-testid="availability-link-active"
              >
                Active
              </span>
            }
          />
          <SettingRow
            label="Replace it"
            description="Makes a new link and kills the old one — the way to stop showing this to someone you've finished with."
            control={
              <Button
                variant="ghost"
                data-testid="availability-link-regenerate"
                disabled={busy}
                onClick={() => create.mutate()}
              >
                {create.isPending ? "Working…" : "Regenerate"}
              </Button>
            }
          />
          <SettingRow
            label="Turn it off"
            description="Stops the link immediately. Anyone who opens it sees only that it isn't active."
            control={
              <Button
                variant="ghost"
                data-testid="availability-link-revoke"
                disabled={busy}
                onClick={() => revoke.mutate()}
              >
                {revoke.isPending ? "Working…" : "Turn off"}
              </Button>
            }
          />
        </>
      )}

      {notice !== null && (
        <p className="pt-3 text-xs text-slate-600" data-testid="availability-link-notice">
          {notice}
        </p>
      )}
    </SettingGroup>
  );
}
