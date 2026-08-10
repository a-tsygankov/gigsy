/**
 * Drizzle schema — mirrors migrations/0000_init.sql.
 *
 * Conventions (docs/plan.md §4):
 * - TEXT UUID primary keys, client-generated — offline sync retries
 *   upsert by ID instead of duplicating records.
 * - Epoch-ms INTEGER timestamps. `modifiedAt` is set on insert and
 *   bumped on every update; it is the offline-sync conflict signal
 *   (last-write-wins).
 * - Money is integer cents, never floating point.
 * - Every query is scoped by userId from the verified JWT claim —
 *   that's the entire multi-tenancy boundary.
 */
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  // AES-GCM ciphertext, key = REFRESH_TOKEN_ENC_KEY secret (Phase 2).
  googleRefreshTokenEnc: text("google_refresh_token_enc"),
  // Calendar-sync watermark (docs/plan.md §9): gigs modified after
  // this get processed by the next run.
  lastCalendarSyncAt: integer("last_calendar_sync_at"),
  // Nudge throttling lives on the user, not the device: the cap is one
  // notification per person per day, whatever they're holding.
  lastPushAt: integer("last_push_at"),
  lastPushKey: text("last_push_key"),
  // User preferences as one JSON blob (Phase 11). NULL means "all
  // defaults"; reads go through parseSettings(), so a row written
  // before a setting existed is still valid.
  settingsJson: text("settings_json"),
  createdAt: integer("created_at").notNull(),
  modifiedAt: integer("modified_at").notNull(),
});

// Opaque rotating refresh tokens (docs/plan.md §6). Only SHA-256
// hashes are stored — mirrors migrations/0001_refresh_tokens.sql.
export const refreshTokens = sqliteTable(
  "refresh_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    userIdx: index("idx_refresh_tokens_user").on(t.userId),
  }),
);

/**
 * Public availability links (Phase 12) — mirrors
 * migrations/0010_availability_tokens.sql.
 *
 * Only SHA-256 hashes, as with refreshTokens: the token is the whole
 * access control for /api/a/:token, so a leaked database must not hand
 * over live links. Revoked and expired rows are kept rather than
 * deleted — one active link per user is enforced by revoking the old
 * one, and a dead link stays distinguishable from one that never was.
 */
export const availabilityTokens = sqliteTable(
  "availability_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    createdAt: integer("created_at").notNull(),
    /** NULL means it does not expire on its own. */
    expiresAt: integer("expires_at"),
    revokedAt: integer("revoked_at"),
  },
  (t) => ({
    userIdx: index("idx_availability_tokens_user").on(t.userId),
  }),
);

// Agencies/companies/individuals a user works gigs for. Private per
// user — not shared even if two users work for the same agency.
export const clients = sqliteTable(
  "clients",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    contactInfo: text("contact_info"),
    notes: text("notes"),
    createdAt: integer("created_at").notNull(),
    modifiedAt: integer("modified_at").notNull(),
  },
  // Uniqueness of names is enforced app-level (fuzzy matching in the
  // capture flow) — a hard UNIQUE would block legit near-duplicates.
  (t) => ({
    userNameIdx: index("idx_clients_user_name").on(t.userId, t.name),
  }),
);

export const GIG_STATUSES = ["lead", "confirmed", "completed", "paid"] as const;
export type GigStatus = (typeof GIG_STATUSES)[number];

export const gigs = sqliteTable(
  "gigs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    clientId: text("client_id").references(() => clients.id),
    status: text("status").$type<GigStatus>().notNull().default("lead"),
    location: text("location"),
    dateTime: integer("date_time"),
    // How long the gig runs. A length rather than an end timestamp, so
    // it can't go stale when the start moves; the calendar sync uses it
    // in place of its 4h default.
    durationMinutes: integer("duration_minutes"),
    calendarEventId: text("calendar_event_id"),
    amountOfferedCents: integer("amount_offered_cents"),
    amountPaidCents: integer("amount_paid_cents"),
    notes: text("notes"),
    // Where the record came from: manual | email | photo.
    source: text("source"),
    createdAt: integer("created_at").notNull(),
    // When the *author* last changed it — the phone's clock, carried
    // through /api/sync so last-write-wins works between devices.
    modifiedAt: integer("modified_at").notNull(),
    // When the *server* last stored it. Only the worker writes this, so
    // it is the only timestamp the calendar watermark can safely be
    // compared against: an offline edit arrives with an old modifiedAt
    // but a fresh serverModifiedAt.
    serverModifiedAt: integer("server_modified_at").notNull().default(0),
  },
  (t) => ({
    userDateIdx: index("idx_gigs_user_date").on(t.userId, t.dateTime),
    userServerModifiedIdx: index("idx_gigs_user_server_modified").on(
      t.userId,
      t.serverModifiedAt,
    ),
    userStatusIdx: index("idx_gigs_user_status").on(t.userId, t.status),
    clientIdx: index("idx_gigs_client").on(t.clientId),
  }),
);

// Money-received records. confirmation_r2_key is server-controlled
// (upload endpoint only) — proof photo / mail screenshot in R2.
export const payments = sqliteTable(
  "payments",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    gigId: text("gig_id").references(() => gigs.id),
    amountCents: integer("amount_cents").notNull(),
    paidAt: integer("paid_at"),
    confirmationR2Key: text("confirmation_r2_key"),
    notes: text("notes"),
    createdAt: integer("created_at").notNull(),
    modifiedAt: integer("modified_at").notNull(),
  },
  (t) => ({
    userIdx: index("idx_payments_user").on(t.userId),
    gigIdx: index("idx_payments_gig").on(t.gigId),
  }),
);

// Additional services on a gig (docs plan: addable at any time with a
// promised payment). Client link derives through the gig.
export const gigServices = sqliteTable(
  "gig_services",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    gigId: text("gig_id")
      .notNull()
      .references(() => gigs.id),
    description: text("description").notNull(),
    amountOfferedCents: integer("amount_offered_cents"),
    amountPaidCents: integer("amount_paid_cents"),
    paymentId: text("payment_id").references(() => payments.id),
    isCompleted: integer("is_completed", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: integer("created_at").notNull(),
    modifiedAt: integer("modified_at").notNull(),
  },
  (t) => ({
    userIdx: index("idx_gig_services_user").on(t.userId),
    gigIdx: index("idx_gig_services_gig").on(t.gigId),
  }),
);

// AI-capture drafts (docs/plan.md §8) — the review gate between
// photo/email capture and real records; never auto-committed.
export const DRAFT_SOURCES = ["email", "photo"] as const;
export type DraftSource = (typeof DRAFT_SOURCES)[number];
export const DRAFT_STATUSES = ["pending", "confirmed", "discarded"] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

export const drafts = sqliteTable(
  "drafts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    source: text("source").$type<DraftSource>().notNull(),
    status: text("status").$type<DraftStatus>().notNull().default("pending"),
    rawR2Key: text("raw_r2_key"),
    extractedJson: text("extracted_json").notNull(),
    createdAt: integer("created_at").notNull(),
    modifiedAt: integer("modified_at").notNull(),
  },
  (t) => ({
    userStatusIdx: index("idx_drafts_user_status").on(t.userId, t.status),
  }),
);

export const expenses = sqliteTable(
  "expenses",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    gigId: text("gig_id").references(() => gigs.id),
    amountCents: integer("amount_cents").notNull(),
    category: text("category"),
    receiptR2Key: text("receipt_r2_key"),
    notes: text("notes"),
    // The client is expected to cover this cost. An expectation, not a
    // receipt — net income still subtracts it (reports.ts).
    reimbursable: integer("reimbursable", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: integer("created_at").notNull(),
    modifiedAt: integer("modified_at").notNull(),
  },
  (t) => ({
    userIdx: index("idx_expenses_user").on(t.userId),
    gigIdx: index("idx_expenses_gig").on(t.gigId),
  }),
);

/**
 * Calendar events whose gig has been deleted (Phase 8 hardening).
 * The row that held the event id is gone by the time the cron runs, so
 * GigsRepo.remove() parks the id here and the next sync run deletes the
 * event. A failed delete stays queued and retries.
 */
export const calendarCleanup = sqliteTable(
  "calendar_cleanup",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    calendarEventId: text("calendar_event_id").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    userIdx: index("idx_calendar_cleanup_user").on(t.userId),
  }),
);

/** A browser/device subscription (Phase 10). Keyed by the push
 * service's own endpoint, so re-subscribing replaces rather than
 * duplicates. */
export const pushSubscriptions = sqliteTable(
  "push_subscriptions",
  {
    endpoint: text("endpoint").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    userIdx: index("idx_push_subscriptions_user").on(t.userId),
  }),
);
