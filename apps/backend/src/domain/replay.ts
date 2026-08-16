import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "../db/client.js";
import { deliveries } from "../db/schema.js";

export type ReplayDeliveryResult = {
  sourceDelivery: {
    id: string;
    status: "dead_letter";
  };
  delivery: {
    id: string;
    eventId: string;
    endpointId: string;
    status: "queued" | "delivering" | "retry_scheduled" | "delivered" | "dead_letter";
    attemptCount: number;
    nextAttemptAt: Date | null;
    deliveredAt: Date | null;
    replayedFromDeliveryId: string | null;
    createdAt: Date;
  };
  reused: boolean;
};

export class DeliveryNotFoundError extends Error {
  constructor() {
    super("Delivery was not found.");
    this.name = "DeliveryNotFoundError";
  }
}

export class DeliveryNotReplayableError extends Error {
  constructor(readonly status: string) {
    super(`Only dead-letter deliveries can be replayed; this delivery is ${status}.`);
    this.name = "DeliveryNotReplayableError";
  }
}

function hasPostgresCode(error: unknown, code: string): boolean {
  let current: unknown = error;

  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if ("code" in current && current.code === code) return true;
    current = "cause" in current ? current.cause : undefined;
  }

  return false;
}

const replaySelection = {
  id: deliveries.id,
  eventId: deliveries.eventId,
  endpointId: deliveries.endpointId,
  status: deliveries.status,
  attemptCount: deliveries.attemptCount,
  nextAttemptAt: deliveries.nextAttemptAt,
  deliveredAt: deliveries.deliveredAt,
  replayedFromDeliveryId: deliveries.replayedFromDeliveryId,
  createdAt: deliveries.createdAt,
};

async function loadSourceDelivery(db: AppDatabase, deliveryId: string) {
  const [source] = await db
    .select({
      id: deliveries.id,
      eventId: deliveries.eventId,
      endpointId: deliveries.endpointId,
      status: deliveries.status,
    })
    .from(deliveries)
    .where(eq(deliveries.id, deliveryId))
    .limit(1);

  return source;
}

async function loadExistingReplay(
  db: AppDatabase,
  sourceDeliveryId: string,
  idempotencyKey: string,
) {
  const [delivery] = await db
    .select(replaySelection)
    .from(deliveries)
    .where(
      and(
        eq(deliveries.replayedFromDeliveryId, sourceDeliveryId),
        eq(deliveries.replayIdempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);

  return delivery;
}

function assertReplayable(
  source: Awaited<ReturnType<typeof loadSourceDelivery>>,
): asserts source is NonNullable<typeof source> & { status: "dead_letter" } {
  if (!source) throw new DeliveryNotFoundError();
  if (source.status !== "dead_letter") {
    throw new DeliveryNotReplayableError(source.status);
  }
}

export async function replayDelivery(
  db: AppDatabase,
  input: { sourceDeliveryId: string; idempotencyKey: string },
): Promise<ReplayDeliveryResult> {
  try {
    return await db.transaction(async (transaction) => {
      const source = await loadSourceDelivery(transaction, input.sourceDeliveryId);
      assertReplayable(source);

      const [delivery] = await transaction
        .insert(deliveries)
        .values({
          eventId: source.eventId,
          endpointId: source.endpointId,
          replayedFromDeliveryId: source.id,
          replayIdempotencyKey: input.idempotencyKey,
        })
        .returning(replaySelection);

      if (!delivery) throw new Error("Replay delivery insert returned no row.");

      return {
        sourceDelivery: { id: source.id, status: source.status },
        delivery,
        reused: false,
      };
    });
  } catch (error) {
    if (!hasPostgresCode(error, "23505")) throw error;

    const source = await loadSourceDelivery(db, input.sourceDeliveryId);
    assertReplayable(source);
    const delivery = await loadExistingReplay(
      db,
      input.sourceDeliveryId,
      input.idempotencyKey,
    );
    if (!delivery) throw error;

    return {
      sourceDelivery: { id: source.id, status: source.status },
      delivery,
      reused: true,
    };
  }
}
