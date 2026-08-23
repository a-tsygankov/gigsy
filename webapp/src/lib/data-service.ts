/**
 * The screens' data facade — the exact method shape they already
 * called on ApiClient in Phase 3, now backed by the local store
 * (docs/plan.md §7: reads/writes never block on the network). Every
 * write nudges the SyncEngine's debounced drain. Reports remain
 * server-computed — grouped SQL beats re-implementing it in Dexie.
 */
import type { SettingsPatch } from "./settings-schema.ts";
import type { LocalStore, QueueImageResult } from "./local-store.ts";
import type { PendingImage } from "./db.ts";
import type { SyncEngine } from "./sync-engine.ts";
import type { ApiClient } from "./api.ts";
import type {
  Allocation,
  AllocationInput,
  Client,
  ClientInput,
  DashboardSummary,
  Draft,
  Expense,
  ExpenseInput,
  Gig,
  GigInput,
  Payment,
  PaymentInput,
  ReportFilters,
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
      | "capturePhoto"
      | "listDrafts"
      | "getDraft"
      | "setDraftStatus"
      | "confirmDraftAsPayment"
      | "getDraftRawBlob"
      | "getPushConfig"
      | "savePushSubscription"
      | "deletePushSubscription"
      | "reverseGeocode"
      | "getCalendarStatus"
      | "connectCalendar"
      | "disconnectCalendar"
      | "calendarSyncNow"
      | "calendarResync"
      | "createDedicatedCalendar"
      | "checkCalendarFreeBusy"
      | "getCaptureAddress"
      | "getAvailabilityLink"
      | "createAvailabilityLink"
      | "revokeAvailabilityLink"
      | "getSettings"
      | "updateSettings"
    >,
  ) {}

  private nudge(): void {
    void this.engine.notifyLocalChange();
  }

  /** Money invariant (user requirement 2026-08-08): amounts are
   * strictly positive when present; "no amount" is null, never 0.
   * Enforced here — not just in screens — because an offline write
   * with a bad amount would later sync-error and be poison-dropped. */
  private assertPositive(
    amounts: Record<string, number | null | undefined>,
  ): void {
    for (const [field, value] of Object.entries(amounts)) {
      if (value != null && value <= 0) {
        throw new Error(`${field} must be a positive amount`);
      }
    }
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
    this.assertPositive({
      amountOfferedCents: input.amountOfferedCents,
      amountPaidCents: input.amountPaidCents,
      hourlyRateCents: input.hourlyRateCents,
    });
    const record = await this.store.putGig(id, input);
    this.nudge();
    return record;
  }
  async deleteGig(id: string): Promise<void> {
    await this.store.removeGig(id);
    this.nudge();
  }
  /** Gig ids whose changes have not reached the server yet. */
  pendingGigIds(): Promise<Set<string>> {
    return this.store.pendingIds("gig");
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
    this.assertPositive({ amountCents: input.amountCents });
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
    this.assertPositive({
      amountOfferedCents: input.amountOfferedCents,
      amountPaidCents: input.amountPaidCents,
    });
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
    this.assertPositive({ amountCents: input.amountCents });
    const record = await this.store.putPayment(id, input);
    this.nudge();
    return record;
  }
  async deletePayment(id: string): Promise<void> {
    await this.store.removePayment(id);
    this.nudge();
  }

  // ── allocations ──────────────────────────────────────────────────
  listAllocationsByPayment(paymentId: string): Promise<Allocation[]> {
    return this.store.listAllocationsByPayment(paymentId);
  }
  listAllocations(): Promise<Allocation[]> {
    return this.store.listAllocations();
  }
  listAllocationsByGig(gigId: string): Promise<Allocation[]> {
    return this.store.listAllocationsByGig(gigId);
  }
  async getAllocation(id: string): Promise<Allocation> {
    return this.require(await this.store.getAllocation(id));
  }
  async putAllocation(id: string, input: AllocationInput): Promise<Allocation> {
    // A zero or negative allocation is a deleted allocation with extra
    // steps — the server says so too (AllocationInput.positiveCents),
    // and an offline write it would refuse is a write this device would
    // lose on the next drain.
    this.assertPositive({ amountCents: input.amountCents });
    const record = await this.store.putAllocation(id, input);
    this.nudge();
    return record;
  }
  async deleteAllocation(id: string): Promise<void> {
    await this.store.removeAllocation(id);
    this.nudge();
  }

  /**
   * Direct upload, no queue — ONE caller, and it is not a screen
   * choosing a file.
   *
   * `DraftReview` uses it to repair a receipt draft whose server-side
   * photo copy failed (Task 9): the bytes are already in R2 under the
   * draft's key, it has just finished an online call to create the
   * payment, and the repair is a re-send of something the server owns
   * rather than something this device is holding. Spooling megabytes
   * into IndexedDB to move them between two server-side keys would be
   * the wrong shape entirely.
   *
   * Every file a USER picks goes through `queuePaymentConfirmation`
   * below instead.
   */
  uploadPaymentConfirmation(id: string, file: Blob) {
    return this.reportsApi.uploadPaymentConfirmation(id, file);
  }
  /**
   * Hand a payment's proof photo to the queue. The SyncEngine uploads
   * it on the next drain — immediately when there is a connection,
   * whenever one returns otherwise.
   *
   * There is no direct-upload sibling any more. The screen used to
   * call `ApiClient.uploadPaymentConfirmation` itself and simply tell
   * the user "uploads need a connection" when there wasn't one, which
   * meant the proof for a payment recorded on a job site could not be
   * attached at the moment it was in front of the camera.
   */
  async queuePaymentConfirmation(id: string, file: Blob): Promise<QueueImageResult> {
    const result = await this.store.queueImage(id, file);
    // Only on success: a refusal changed nothing, and nudging the
    // engine over it would show a sync that has no work to do.
    if (result.queued) this.nudge();
    return result;
  }
  /** This payment's photo as it sits on the device — waiting, or
   *  tombstoned after a refusal the screen has to explain. Null when
   *  there is nothing queued, which is the ordinary case. */
  queuedPaymentConfirmation(id: string): Promise<PendingImage | null> {
    return this.store.queuedImage(id);
  }
  getPaymentConfirmationBlob(id: string): Promise<Blob | null> {
    return this.reportsApi.getPaymentConfirmationBlob(id);
  }

  // ── capture + drafts (online-only server records) ────────────────
  capturePhoto(file: Blob) {
    return this.reportsApi.capturePhoto(file);
  }
  listDrafts(status?: Draft["status"]) {
    return this.reportsApi.listDrafts(status);
  }
  getDraft(id: string) {
    return this.reportsApi.getDraft(id);
  }
  setDraftStatus(id: string, status: "confirmed" | "discarded") {
    return this.reportsApi.setDraftStatus(id, status);
  }
  getDraftRawBlob(id: string) {
    return this.reportsApi.getDraftRawBlob(id);
  }
  /** Commits a receipt draft straight to the server (see ApiClient) and
   * seeds the local store with the result via `applyServerRecord`, the
   * same server-authoritative write path a pull uses — never through
   * `putPayment`'s outbox, which would race the server-side photo copy
   * this call performs. */
  async confirmDraftAsPayment(
    draftId: string,
    paymentId: string,
    input: PaymentInput,
  ): Promise<Payment> {
    this.assertPositive({ amountCents: input.amountCents });
    const record = await this.reportsApi.confirmDraftAsPayment(
      draftId,
      paymentId,
      input,
    );
    await this.store.applyServerRecord("payment", record);
    return record;
  }

  // ── calendar (online-only) ───────────────────────────────────────
  getPushConfig() {
    return this.reportsApi.getPushConfig();
  }
  savePushSubscription(input: { endpoint: string; p256dh: string; auth: string }) {
    return this.reportsApi.savePushSubscription(input);
  }
  deletePushSubscription(endpoint: string) {
    return this.reportsApi.deletePushSubscription(endpoint);
  }
  reverseGeocode(lat: number, lon: number) {
    return this.reportsApi.reverseGeocode(lat, lon);
  }
  getCalendarStatus() {
    return this.reportsApi.getCalendarStatus();
  }
  connectCalendar(authCode: string) {
    return this.reportsApi.connectCalendar(authCode);
  }
  disconnectCalendar() {
    return this.reportsApi.disconnectCalendar();
  }
  calendarResync() {
    return this.reportsApi.calendarResync();
  }
  createDedicatedCalendar() {
    return this.reportsApi.createDedicatedCalendar();
  }
  /** Phase 12: whether the stored grant can read busy time at all. */
  checkCalendarFreeBusy() {
    return this.reportsApi.checkCalendarFreeBusy();
  }
  /** Where this user forwards booking emails, or null when the
   *  deployment has no capture domain configured. */
  getCaptureAddress() {
    return this.reportsApi.getCaptureAddress();
  }
  getAvailabilityLink() {
    return this.reportsApi.getAvailabilityLink();
  }
  createAvailabilityLink(expiresInDays: number | null = null) {
    return this.reportsApi.createAvailabilityLink(expiresInDays);
  }
  revokeAvailabilityLink() {
    return this.reportsApi.revokeAvailabilityLink();
  }
  getSettings() {
    return this.reportsApi.getSettings();
  }
  updateSettings(patch: SettingsPatch) {
    return this.reportsApi.updateSettings(patch);
  }
  calendarSyncNow() {
    return this.reportsApi.calendarSyncNow();
  }

  // ── reports (server-computed) ────────────────────────────────────
  getReportSummary(filters: ReportFilters = {}): Promise<ReportSummary> {
    return this.reportsApi.getReportSummary(filters);
  }
  getDashboard(window: { futureFrom?: number; futureTo?: number } = {}): Promise<DashboardSummary> {
    return this.reportsApi.getDashboard(window);
  }
}
