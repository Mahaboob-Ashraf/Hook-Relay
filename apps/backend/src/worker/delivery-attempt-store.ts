import { and, eq, isNull, ne, sql } from "drizzle-orm";
import type { AppDatabase } from "../db/client.js";
import { deliveries, deliveryAttempts } from "../db/schema.js";

export type StartedDeliveryAttempt = {
  id: string;
  deliveryId: string;
  attemptNumber: number;
  startedAt: Date;
};

export type DeliveryAttemptFinalization = {
  completedAt: Date;
  responseStatus: number | null;
  latencyMs: number;
  errorMessage: string | null;
  deliveryStatus: "retry_scheduled" | "delivered" | "dead_letter";
  nextAttemptAt: Date | null;
  deliveredAt: Date | null;
};

export async function startDeliveryAttempt(
  db: AppDatabase,
  deliveryId: string,
): Promise<StartedDeliveryAttempt | undefined> {
  return db.transaction(async (transaction) => {
    const [startedDelivery] = await transaction
      .update(deliveries)
      .set({
        attemptCount: sql`${deliveries.attemptCount} + 1`,
        status: "delivering",
        nextAttemptAt: null,
      })
      .where(
        and(
          eq(deliveries.id, deliveryId),
          ne(deliveries.status, "delivered"),
          ne(deliveries.status, "dead_letter"),
        ),
      )
      .returning({ attemptNumber: deliveries.attemptCount });

    if (!startedDelivery) return undefined;

    const [attempt] = await transaction
      .insert(deliveryAttempts)
      .values({
        deliveryId,
        attemptNumber: startedDelivery.attemptNumber,
      })
      .returning({
        id: deliveryAttempts.id,
        deliveryId: deliveryAttempts.deliveryId,
        attemptNumber: deliveryAttempts.attemptNumber,
        startedAt: deliveryAttempts.startedAt,
      });

    if (!attempt) throw new Error("Failed to create a durable delivery attempt.");
    return attempt;
  });
}

export async function finalizeDeliveryAttempt(
  db: AppDatabase,
  attempt: StartedDeliveryAttempt,
  finalization: DeliveryAttemptFinalization,
): Promise<void> {
  await db.transaction(async (transaction) => {
    const [finalizedAttempt] = await transaction
      .update(deliveryAttempts)
      .set({
        completedAt: finalization.completedAt,
        responseStatus: finalization.responseStatus,
        latencyMs: finalization.latencyMs,
        errorMessage: finalization.errorMessage,
      })
      .where(
        and(
          eq(deliveryAttempts.id, attempt.id),
          eq(deliveryAttempts.deliveryId, attempt.deliveryId),
          isNull(deliveryAttempts.completedAt),
        ),
      )
      .returning({ id: deliveryAttempts.id });

    if (!finalizedAttempt) {
      throw new Error(
        `Delivery attempt ${attempt.id} was already finalized or missing.`,
      );
    }

    // A newer durable attempt owns delivery state if it has already started.
    await transaction
      .update(deliveries)
      .set({
        status: finalization.deliveryStatus,
        nextAttemptAt: finalization.nextAttemptAt,
        deliveredAt: finalization.deliveredAt,
      })
      .where(
        and(
          eq(deliveries.id, attempt.deliveryId),
          eq(deliveries.attemptCount, attempt.attemptNumber),
          eq(deliveries.status, "delivering"),
        ),
      );
  });
}
