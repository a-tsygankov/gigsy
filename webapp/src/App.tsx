import { Route, Routes } from "react-router-dom";
import { ConsoleProvider } from "./components/ConsoleProvider.tsx";
import { HelpProvider } from "./help/runtime/HelpProvider.tsx";
import { UpdateBar } from "./components/UpdateBar.tsx";
import { AuthGate } from "./components/AuthGate.tsx";
import { Login } from "./screens/Login.tsx";
import { Dashboard } from "./screens/Dashboard.tsx";
import { Gigs } from "./screens/Gigs.tsx";
import { GigEdit } from "./screens/GigEdit.tsx";
import { GigDetail } from "./screens/GigDetail.tsx";
import { Clients } from "./screens/Clients.tsx";
import { ClientEdit } from "./screens/ClientEdit.tsx";
import { Expenses } from "./screens/Expenses.tsx";
import { Reports } from "./screens/Reports.tsx";
import { Settings } from "./screens/Settings.tsx";
import { ExpenseEdit } from "./screens/ExpenseEdit.tsx";
import { ServiceEdit } from "./screens/ServiceEdit.tsx";
import { PaymentEdit } from "./screens/PaymentEdit.tsx";
import { Capture } from "./screens/Capture.tsx";
import { Drafts } from "./screens/Drafts.tsx";
import { DraftReview } from "./screens/DraftReview.tsx";
import { PublicAvailability } from "./screens/PublicAvailability.tsx";
import { Privacy } from "./screens/Privacy.tsx";
import { Landing } from "./screens/Landing.tsx";

export function App() {
  return (
    <ConsoleProvider>
      <HelpProvider>
        {/* Above the routes: a stale bundle is stale on every
            screen, including login and the public page. */}
        <UpdateBar />
        <Routes>
          <Route path="/login" element={<Login />} />
          {/* Public and outside AuthGate: Google's OAuth verification
              needs the policy reachable without an account. */}
          <Route path="/privacy" element={<Privacy />} />
          {/* Outside AuthGate, and the only route that is (Phase 12).
              The token in the path is the whole access control; an
              agency opening this has no account and must never be
              asked for one. */}
          <Route path="/a/:token" element={<PublicAvailability />} />
          {/* "/" answers twice: the dashboard once you are signed in, the
              public landing page when you are not. Google's OAuth
              verification needs a home page that describes the app without
              an account, and the bare domain is where a reviewer — and
              anyone handed a link — actually starts. */}
          <Route element={<AuthGate signedOut={<Landing />} />}>
            <Route path="/" element={<Dashboard />} />
          </Route>
          <Route element={<AuthGate />}>
            <Route path="/gigs" element={<Gigs />} />
            {/* Order matters: "/gigs/new" must come first, or ":id"
                matches it and "new" is read as a gig id. GigEdit still
                treats the literal id "new" as create mode — the two
                routes below it are the same form, one with a record
                behind it and one without. */}
            <Route path="/gigs/new" element={<GigEdit />} />
            {/* A gig opens on its detail hub, never straight into a
                form: the job half is read-only there and the work half
                saves as you touch it (Phase 3). */}
            <Route path="/gigs/:id" element={<GigDetail />} />
            <Route path="/gigs/:id/edit" element={<GigEdit />} />
            <Route path="/services/:id" element={<ServiceEdit />} />
            <Route path="/payments/:id" element={<PaymentEdit />} />
            <Route path="/capture" element={<Capture />} />
            <Route path="/drafts" element={<Drafts />} />
            <Route path="/drafts/:id" element={<DraftReview />} />
            <Route path="/clients" element={<Clients />} />
            <Route path="/clients/:id" element={<ClientEdit />} />
            <Route path="/expenses" element={<Expenses />} />
            <Route path="/expenses/:id" element={<ExpenseEdit />} />
            <Route path="/reports" element={<Reports />} />
            <Route path="/settings" element={<Settings />} />
          </Route>
        </Routes>
      </HelpProvider>
    </ConsoleProvider>
  );
}
