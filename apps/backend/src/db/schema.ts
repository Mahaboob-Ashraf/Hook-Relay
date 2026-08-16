import { sql } from "drizzle-orm";
import {
  AnyPgColumn,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export const deliveryStatus = pgEnum("delivery_status", [
  "queued",
  "delivering",
  "retry_scheduled",
  "delivered",
  "dead_letter",
]);

export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    url: text("url").notNull(),
    signingSecret: text("signing_secret").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("webhook_endpoints_name_nonempty", sql`char_length(btrim(${table.name})) > 0`),
    check(
      "webhook_endpoints_signing_secret_nonempty",
      sql`char_length(btrim(${table.signingSecret})) > 0`,
    ),
    index("webhook_endpoints_created_at_idx").on(table.createdAt, table.id),
  ],
);

export const events = pgTable(
  "events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").$type<JsonValue>().notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("events_idempotency_key_unique").on(table.idempotencyKey),
    check("events_event_type_nonempty", sql`char_length(btrim(${table.eventType})) > 0`),
    check(
      "events_idempotency_key_nonempty",
      sql`char_length(btrim(${table.idempotencyKey})) > 0`,
    ),
  ],
);

export const deliveries = pgTable(
  "deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: "restrict" }),
    status: deliveryStatus("status").default("queued").notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    replayedFromDeliveryId: uuid("replayed_from_delivery_id").references(
      (): AnyPgColumn => deliveries.id,
      { onDelete: "set null" },
    ),
    replayIdempotencyKey: text("replay_idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("deliveries_attempt_count_nonnegative", sql`${table.attemptCount} >= 0`),
    check(
      "deliveries_replay_idempotency_key_nonempty",
      sql`${table.replayIdempotencyKey} is null or char_length(btrim(${table.replayIdempotencyKey})) > 0`,
    ),
    unique("deliveries_replay_idempotency_unique").on(
      table.replayedFromDeliveryId,
      table.replayIdempotencyKey,
    ),
    index("deliveries_event_id_idx").on(table.eventId),
    index("deliveries_endpoint_id_idx").on(table.endpointId),
    index("deliveries_status_next_attempt_idx").on(table.status, table.nextAttemptAt),
  ],
);

export const deliveryAttempts = pgTable(
  "delivery_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    deliveryId: uuid("delivery_id")
      .notNull()
      .references(() => deliveries.id, { onDelete: "cascade" }),
    attemptNumber: integer("attempt_number").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    responseStatus: integer("response_status"),
    latencyMs: integer("latency_ms"),
    errorMessage: text("error_message"),
  },
  (table) => [
    check("delivery_attempts_attempt_number_positive", sql`${table.attemptNumber} > 0`),
    check("delivery_attempts_latency_nonnegative", sql`${table.latencyMs} is null or ${table.latencyMs} >= 0`),
    unique("delivery_attempts_delivery_attempt_unique").on(
      table.deliveryId,
      table.attemptNumber,
    ),
    index("delivery_attempts_delivery_id_idx").on(table.deliveryId),
  ],
);
