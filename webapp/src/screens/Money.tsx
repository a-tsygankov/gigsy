/**
 * Money in and money out, one tab.
 *
 * The segmented control is real navigation — `/payments` and
 * `/expenses` are both routes here — so a filtered view is shareable
 * and the back button behaves. `/expenses` predates this screen and is
 * kept rather than folded into a query parameter, because the
 * `add-expense` help scenario and `HelpProvider.test.tsx` both point at
 * it.
 */
import { AppHeader, Segmented } from "../components/index.ts";

const OPTIONS = [
  { to: "/payments", label: "Payments" },
  { to: "/expenses", label: "Expenses" },
];

export function Money({ children }: { children: React.ReactNode }) {
  return (
    <>
      <AppHeader title="Money" />
      <main className="mx-auto max-w-lg space-y-3 p-4">
        <Segmented options={OPTIONS} label="Money views" testId="money-segment" />
        {children}
      </main>
    </>
  );
}
