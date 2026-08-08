import { Route, Routes } from "react-router-dom";
import { ConsoleProvider } from "./components/ConsoleProvider.tsx";
import { AuthGate } from "./components/AuthGate.tsx";
import { Login } from "./screens/Login.tsx";
import { Gigs } from "./screens/Gigs.tsx";
import { GigEdit } from "./screens/GigEdit.tsx";
import { Clients } from "./screens/Clients.tsx";
import { ClientEdit } from "./screens/ClientEdit.tsx";
import { Expenses } from "./screens/Expenses.tsx";
import { ExpenseEdit } from "./screens/ExpenseEdit.tsx";

export function App() {
  return (
    <ConsoleProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route element={<AuthGate />}>
          <Route path="/" element={<Gigs />} />
          {/* "/gigs/new" rides the :id route — GigEdit treats the
              literal id "new" as create mode. Same for the others. */}
          <Route path="/gigs/:id" element={<GigEdit />} />
          <Route path="/clients" element={<Clients />} />
          <Route path="/clients/:id" element={<ClientEdit />} />
          <Route path="/expenses" element={<Expenses />} />
          <Route path="/expenses/:id" element={<ExpenseEdit />} />
        </Route>
      </Routes>
    </ConsoleProvider>
  );
}
