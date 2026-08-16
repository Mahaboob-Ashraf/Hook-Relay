import { and, asc, eq, isNull } from "drizzle-orm";
import type { AppDatabase } from "../db/client.js";
import { deliveries, events, type JsonValue } from "../db/schema.js";

export type IngestEventInput = {
  endpointId: string;
  eventType: string;
  payload: JsonValue;
  idempotencyKey: string;
};

export type IngestEventResult = {
  event: {
    id: string;
    eventType: string;
    createdAt: Date;
  };
  delivery: {
    id: string;
    status: "queued" | "delivering" | "retry_scheduled" | "delivered" | "dead_letter";
    attemptCount: number;
    createdAt: Date;
  };
  reused: boolean;
};

export class IdempotencyConflictError extends Error {
  constructor() {
    super("The idempotency key was already used for a different request.");
    this.name = "IdempotencyConflictError";
  }
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as JsonValue)}`)
    .join(",")}}`;
}

function hasPostgresCode(error: unknown, code: string): boolean {
  let current: unknown = error;

  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if ("code" in current && current.code === code) return true;
    current = "cause" in current ? current.cause : undefined;
  }

  return false;
}

async function loadExisting(
  db: AppDatabase,
  idempotencyKey: string,
): Promise<(IngestEventResult & { endpointId: string; payload: JsonValue }) | undefined> {
  const [existing] = await db
    .select({
      eventId: events.id,
      eventType: events.eventType,
      payload: events.payload,
      eventCreatedAt: events.createdAt,
      deliveryId: deliveries.id,
      endpointId: deliveries.endpointId,
      deliveryStatus: deliveries.status,
      attemptCount: deliveries.attemptCount,
      deliveryCreatedAt: deliveries.createdAt,
    })
    .from(events)
    .innerJoin(
      deliveries,
      and(
        eq(deliveries.eventId, events.id),
        isNull(deliveries.replayedFromDeliveryId),
      ),
    )
    .where(eq(events.idempotencyKey, idempotencyKey))
    .orderBy(asc(deliveries.createdAt))
    .limit(1);

  if (!existing) return undefined;

  return {
    event: {
      id: existing.eventId,
      eventType: existing.eventType,
      createdAt: existing.eventCreatedAt,
    },
    delivery: {
      id: existing.deliveryId,
      status: existing.deliveryStatus,
      attemptCount: existing.attemptCount,
      createdAt: existing.deliveryCreatedAt,
    },
    endpointId: existing.endpointId,
    payload: existing.payload,
    reused: true,
  };
}

export async function ingestEvent(
  db: AppDatabase,
  input: IngestEventInput,
): Promise<IngestEventResult> {
  try {
    return await db.transaction(async (transaction) => {
      const [event] = await transaction
        .insert(events)
        .values({
          eventType: input.eventType,
          payload: input.payload,
          idempotencyKey: input.idempotencyKey,
        })
        .returning({
          id: events.id,
          eventType: events.eventType,
          createdAt: events.createdAt,
        });

      if (!event) throw new Error("Event insert returned no row.");

      const [delivery] = await transaction
        .insert(deliveries)
        .values({
          eventId: event.id,
          endpointId: input.endpointId,
        })
        .returning({
          id: deliveries.id,
          status: deliveries.status,
          attemptCount: deliveries.attemptCount,
          createdAt: deliveries.createdAt,
        });

      if (!delivery) throw new Error("Delivery insert returned no row.");

      return { event, delivery, reused: false };
    });
  } catch (error) {
    if (!hasPostgresCode(error, "23505")) throw error;

    const existing = await loadExisting(db, input.idempotencyKey);
    if (!existing) throw error;

    const sameRequest =
      existing.endpointId.toLowerCase() === input.endpointId.toLowerCase() &&
      existing.event.eventType === input.eventType &&
      canonicalJson(existing.payload) === canonicalJson(input.payload);

    if (!sameRequest) throw new IdempotencyConflictError();

    const { endpointId: _endpointId, payload: _payload, ...result } = existing;
    return result;
  }
}

