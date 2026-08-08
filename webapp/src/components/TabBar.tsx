import { NavLink } from "react-router-dom";

const TABS = [
  { to: "/", label: "Home", end: true },
  { to: "/gigs", label: "Gigs", end: false },
  { to: "/clients", label: "Clients", end: false },
  { to: "/expenses", label: "Expenses", end: false },
];

export function TabBar() {
  return (
    <nav
      data-testid="tab-bar"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 backdrop-blur"
    >
      <div className="mx-auto flex max-w-lg">
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            className={({ isActive }) =>
              `flex-1 py-3 text-center text-sm font-medium transition-colors duration-150 ` +
              (isActive
                ? "text-emerald-600"
                : "text-slate-500 hover:text-slate-700")
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
