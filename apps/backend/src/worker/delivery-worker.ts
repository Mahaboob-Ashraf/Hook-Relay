import { and, eq } from "drizzle-orm";
import { Worker } from "bullmq";
import { z } from "zod";
import type { AppDatabase } from "../db/client.js";
import { deliveries, events, webhookEndpoints } from "../db/schema.js";
import { serializeJsonDeterministically } from "../domain/ingestion.js";
import {
  DELIVERY_QUEUE_NAME,
  type DeliveryJobData,
} from "../queue/delivery-queue.js";
import {
  closeRedis,
  createBullWorkerRedisClient,
  type RedisClient,
} from "../redis/client.js";

const jobDataSchema = z.object({
  deliveryId: z.uuid(),
}).strict();

export type DeliveryWorkerResources = {
  worker: Worker<DeliveryJobData>;
  connection: RedisClient;
  close(): Promise<void>;
};

export async function processDelivery(
  db: AppDatabase,
  data: unknown,
): Promise<void> {
  const parsed = jobDataSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error("Delivery job data must contain a valid deliveryId UUID.");
  }

  const [canonical] = await db
    .select({
      deliveryId: deliveries.id,
      deliveryStatus: deliveries.status,
      eventId: events.id,
      payload: events.payload,
      endpointUrl: webhookEndpoints.url,
    })
    .from(deliveries)
    .innerJoin(events, eq(events.id, deliveries.eventId))
    .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, deliveries.endpointId))
    .where(eq(deliveries.id, parsed.data.deliveryId))
    .limit(1);

  if (!canonical) {
    throw new Error(
      `Delivery ${parsed.data.deliveryId} or its related event/endpoint was not found.`,
    );
  }

  if (canonical.deliveryStatus === "delivered") {
    return;
  }

  await db
    .update(deliveries)
    .set({ status: "delivering" })
    .where(eq(deliveries.id, canonical.deliveryId));

  try {
    const response = await fetch(canonical.endpointUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: serializeJsonDeterministically(canonical.payload),
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Endpoint returned HTTP ${response.status}.`);
    }

    await db
      .update(deliveries)
      .set({
        status: "delivered",
        deliveredAt: new Date(),
      })
      .where(eq(deliveries.id, canonical.deliveryId));
  } catch (error) {
    await db
      .update(deliveries)
      .set({ status: "queued", deliveredAt: null })
      .where(
        and(
          eq(deliveries.id, canonical.deliveryId),
          eq(deliveries.status, "delivering"),
        ),
      );

    const message = error instanceof Error ? error.message : "Unknown delivery error";
    throw new Error(`Delivery ${canonical.deliveryId} failed: ${message}`, {
      cause: error,
    });
  }
}

export function createDeliveryWorker(
  db: AppDatabase,
  redisUrl: string,
): DeliveryWorkerResources {
  const connection = createBullWorkerRedisClient(redisUrl);
  const worker = new Worker<DeliveryJobData>(
    DELIVERY_QUEUE_NAME,
    async (job) => processDelivery(db, job.data),
    { connection },
  );

  worker.on("error", () => undefined);

  return {
    worker,
    connection,
    async close(): Promise<void> {
      await worker.close();
      await closeRedis(connection);
    },
  };
}

