import { Link, useLocation } from "react-router-dom";

// Text-only tabs, no icons (docs/design-system.md). Five fit at 375px
// with room to spare over the 44px tap minimum.
//
// `match` is the set of path prefixes the tab owns, which is not always
// just `to`: the Money tab points at /payments but also holds /expenses
// behind its segmented control, and a tab that goes dark while you are
// standing inside it is worse than no highlight at all. `NavLink`
// cannot express "this tab also owns another prefix" — its `isActive`
// only ever compares against its own single `to` — so ownership is
// computed explicitly here instead, and each tab renders as a plain
// `Link` with `aria-current` set from that computation.
const TABS = [
  { to: "/", label: "Home", match: ["/"], exact: true },
  { to: "/gigs", label: "Gigs", match: ["/gigs"], exact: false },
  { to: "/clients", label: "Clients", match: ["/clients"], exact: false },
  { to: "/payments", label: "Money", match: ["/payments", "/expenses"], exact: false },
  { to: "/reports", label: "Reports", match: ["/reports"], exact: false },
];

function owns(pathname: string, prefixes: string[], exact: boolean): boolean {
  return prefixes.some((p) =>
    exact ? pathname === p : pathname === p || pathname.startsWith(`${p}/`),
  );
}

export function TabBar() {
  const { pathname } = useLocation();

  return (
    <nav
      data-testid="tab-bar"
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 backdrop-blur
                 pb-[env(safe-area-inset-bottom)]"
    >
      <div className="mx-auto flex max-w-lg">
        {TABS.map((tab) => {
          const isActive = owns(pathname, tab.match, tab.exact);
          return (
            <Link
              key={tab.to}
              to={tab.to}
              aria-current={isActive ? "page" : undefined}
              className={
                `flex-1 py-3 text-center text-sm font-medium transition-colors duration-150 ` +
                (isActive
                  ? "text-emerald-600"
                  : "text-slate-500 hover:text-slate-700")
              }
            >
              {tab.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
