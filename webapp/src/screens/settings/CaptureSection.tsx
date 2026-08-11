/**
 * Where to forward a booking email.
 *
 * The handler that turns a forwarded email into a draft has worked
 * since Phase 5, and nothing ever told anyone their address — a
 * working inbox nobody can find is not a feature. This is that.
 *
 * It also says plainly that the message goes to an AI provider to be
 * read. The privacy policy says so too, but the screen where you copy
 * the address is where someone is actually deciding what to forward.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useData } from "../../lib/app-context.tsx";
import { Button, SettingGroup } from "../../components/index.ts";

export function CaptureSection() {
  const data = useData();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const address = useQuery({
    queryKey: ["capture-address"],
    queryFn: () => data.getCaptureAddress(),
  });

  return (
    <SettingGroup
      title="Capture by email"
      description="Forward a booking email and it becomes a draft to review — nothing is created without you confirming it."
      data-testid="settings-capture"
    >
      {address.isPending && <p className="py-3 text-xs text-slate-400">Loading…</p>}

      {address.isError && (
        <p className="py-3 text-xs text-amber-700">
          Couldn't load your forwarding address. It needs a connection.
        </p>
      )}

      {address.data?.address === null && (
        // Deliberately not a half-built address: one that bounces is
        // worse than none, because it gets typed into a mail client
        // and trusted.
        <p className="py-3 text-xs text-slate-500" data-testid="capture-unconfigured">
          Email capture isn't switched on for this deployment yet.
        </p>
      )}

      {address.data?.address != null && (
        <div className="py-3" data-testid="capture-address">
          <p className="text-sm font-medium text-slate-900">Your forwarding address</p>
          <p
            className="mt-2 select-all break-all rounded-xl bg-slate-200 px-3 py-2 font-mono text-xs text-slate-700"
            data-testid="capture-address-value"
          >
            {address.data.address}
          </p>
          <Button
            variant="soft"
            className="mt-2"
            data-testid="capture-address-copy"
            onClick={() => {
              const value = address.data?.address;
              if (value == null) return;
              void navigator.clipboard
                .writeText(value)
                .then(() => setCopied(true))
                // Clipboard access can be refused; the text above is
                // select-all for exactly that case.
                .catch(() => setError("Couldn't copy — select the address above."));
            }}
          >
            {copied ? "Copied" : "Copy address"}
          </Button>

          <p className="mt-3 text-xs leading-relaxed text-slate-500">
            Anything you forward is sent to an AI provider to be read, so it can
            pull out the client, date and amount. Don't forward anything you
            wouldn't put into someone else's system. The original is kept so you
            can check what was extracted.
          </p>
          {error !== null && (
            <p className="mt-2 text-xs text-red-600">{error}</p>
          )}
        </div>
      )}
    </SettingGroup>
  );
}
