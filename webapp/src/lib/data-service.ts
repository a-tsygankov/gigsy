/**
 * The screens' data facade — the exact method shape they already
 * called on ApiClient in Phase 3, now backed by the local store
 * (docs/plan.md §7: reads/writes never block on the network). Every
 * write nudges the SyncEngine's debounced drain. Reports remain
 * server-computed — grouped SQL beats re-implementing it in Dexie.
 */
import type { LocalStore } from "./local-store.ts";
import type { SyncEngine } from "./sync-engine.ts";
import type { ApiClient } from "./api.ts";
import type {
  Client,
  ClientInput,
  DashboardSummary,
  Expense,
  ExpenseInput,
  Gig,
  GigInput,
  Payment,
  PaymentInput,
  ReportSummary,
  Service,
  ServiceInput,
} from "./types.ts";

export class OfflineDataService {
  constructor(
    private readonly store: LocalStore,
    private readonly engine: Pick<SyncEngine, "notifyLocalChange">,
    private readonly reportsApi: Pick<
      ApiClient,
      | "getReportSummary"
      | "getDashboard"
      | "uploadPaymentConfirmation"
      | "getPaymentConfirmationBlob"
    >,
  ) {}

  private nudge(): void {
    void this.engine.notifyLocalChange();
  }

  private require<T>(record: T | null): T {
    if (record === null) throw new Error("not found");
    return record;
  }

  // ── gigs ─────────────────────────────────────────────────────────
  listGigs(): Promise<Gig[]> {
    return this.store.listGigs();
  }
  async getGig(id: string): Promise<Gig> {
    return this.require(await this.store.getGig(id));
  }
  async putGig(id: string, input: GigInput): Promise<Gig> {
    const record = await this.store.putGig(id, input);
    this.nudge();
    return record;
  }
  async deleteGig(id: string): Promise<void> {
    await this.store.removeGig(id);
    this.nudge();
  }

  // ── clients ──────────────────────────────────────────────────────
  listClients(): Promise<Client[]> {
    return this.store.listClients();
  }
  async getClient(id: string): Promise<Client> {
    return this.require(await this.store.getClient(id));
  }
  async putClient(id: string, input: ClientInput): Promise<Client> {
    const record = await this.store.putClient(id, input);
    this.nudge();
    return record;
  }
  async deleteClient(id: string): Promise<void> {
    await this.store.removeClient(id);
    this.nudge();
  }

  // ── expenses ─────────────────────────────────────────────────────
  listExpenses(): Promise<Expense[]> {
    return this.store.listExpenses();
  }
  async getExpense(id: string): Promise<Expense> {
    return this.require(await this.store.getExpense(id));
  }
  async putExpense(id: string, input: ExpenseInput): Promise<Expense> {
    const record = await this.store.putExpense(id, input);
    this.nudge();
    return record;
  }
  async deleteExpense(id: string): Promise<void> {
    await this.store.removeExpense(id);
    this.nudge();
  }

  // ── services ─────────────────────────────────────────────────────
  listServices(): Promise<Service[]> {
    return this.store.listServices();
  }
  listServicesByGig(gigId: string): Promise<Service[]> {
    return this.store.listServicesByGig(gigId);
  }
  async getService(id: string): Promise<Service> {
    return this.require(await this.store.getService(id));
  }
  async putService(id: string, input: ServiceInput): Promise<Service> {
    const record = await this.store.putService(id, input);
    this.nudge();
    return record;
  }
  async deleteService(id: string): Promise<void> {
    await this.store.removeService(id);
    this.nudge();
  }

  // ── payments ─────────────────────────────────────────────────────
  listPayments(): Promise<Payment[]> {
    return this.store.listPayments();
  }
  listPaymentsByGig(gigId: string): Promise<Payment[]> {
    return this.store.listPaymentsByGig(gigId);
  }
  async getPayment(id: string): Promise<Payment> {
    return this.require(await this.store.getPayment(id));
  }
  async putPayment(id: string, input: PaymentInput): Promise<Payment> {
    const record = await this.store.putPayment(id, input);
    this.nudge();
    return record;
  }
  async deletePayment(id: string): Promise<void> {
    await this.store.removePayment(id);
    this.nudge();
  }

  /** Online-only (deferred photo queue generalizes this later). */
  uploadPaymentConfirmation(id: string, file: Blob) {
    return this.reportsApi.uploadPaymentConfirmation(id, file);
  }
  getPaymentConfirmationBlob(id: string): Promise<Blob | null> {
    return this.reportsApi.getPaymentConfirmationBlob(id);
  }

  // ── reports (server-computed) ────────────────────────────────────
  getReportSummary(): Promise<ReportSummary> {
    return this.reportsApi.getReportSummary();
  }
  getDashboard(window: { futureFrom?: number; futureTo?: number } = {}): Promise<DashboardSummary> {
    return this.reportsApi.getDashboard(window);
  }
}
