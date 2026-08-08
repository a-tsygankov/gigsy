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
  createdAt: integer("created_at").notNull(),
  modifiedAt: integer("modified_at").notNull(),
});

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
    calendarEventId: text("calendar_event_id"),
    amountOfferedCents: integer("amount_offered_cents"),
    amountPaidCents: integer("amount_paid_cents"),
    notes: text("notes"),
    // Where the record came from: manual | email | photo.
    source: text("source"),
    createdAt: integer("created_at").notNull(),
    modifiedAt: integer("modified_at").notNull(),
  },
  (t) => ({
    userDateIdx: index("idx_gigs_user_date").on(t.userId, t.dateTime),
    userStatusIdx: index("idx_gigs_user_status").on(t.userId, t.status),
    clientIdx: index("idx_gigs_client").on(t.clientId),
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
    createdAt: integer("created_at").notNull(),
    modifiedAt: integer("modified_at").notNull(),
  },
  (t) => ({
    userIdx: index("idx_expenses_user").on(t.userId),
    gigIdx: index("idx_expenses_gig").on(t.gigId),
  }),
);
