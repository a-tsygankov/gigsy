/**
 * Money in and money out, one tab.
 *
 * The segmented control is real navigation — `/payments` and
 * `/expenses` are both routes here — so a filtered view is shareable
 * and the back button behaves. `/expenses` predates this screen and is
 * kept as its own route rather than folded into a query parameter,
 * because `TabBar.tsx` links straight to it and a user may already have
 * it bookmarked — neither would survive being rewritten to `?view=`.
 *
 * A layout route, same idiom as `AuthGate` one level up: `App.tsx`
 * nests `/payments` and `/expenses` under this element and it renders
 * `<Outlet />` for whichever matched, rather than each route wrapping
 * its screen in `<Money>` by hand.
 */
import { Outlet } from "react-router-dom";
import { AppHeader, Segmented } from "../components/index.ts";

const OPTIONS = [
  { to: "/payments", label: "Payments" },
  { to: "/expenses", label: "Expenses" },
];

export function Money() {
  return (
    <>
      <AppHeader title="Money" />
      <main className="mx-auto max-w-lg space-y-3 p-4">
        <Segmented options={OPTIONS} label="Money views" testId="money-segment" />
        <Outlet />
      </main>
    </>
  );
}
