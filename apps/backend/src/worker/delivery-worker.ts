import { and, eq } from "drizzle-orm";
import { UnrecoverableError, Worker } from "bullmq";
import { z } from "zod";
import type { AppDatabase } from "../db/client.js";
import { deliveries, events, webhookEndpoints } from "../db/schema.js";
import { serializeJsonDeterministically } from "../domain/ingestion.js";
import { createWebhookSignature } from "../signing/webhook-signature.js";
import {
  DELIVERY_BACKOFF_STRATEGY,
  DELIVERY_QUEUE_NAME,
  type DeliveryJobData,
} from "../queue/delivery-queue.js";
import {
  closeRedis,
  createBullWorkerRedisClient,
  type RedisClient,
} from "../redis/client.js";
import {
  classifyDeliveryResult,
  getRetryDelayMs,
  PRODUCTION_RETRY_POLICY,
  type DeliveryResultClassification,
  type DeliveryRetryPolicy,
} from "../retry/delivery-retry-policy.js";

const DEFAULT_WEBHOOK_TIMEOUT_MS = 5_000;

const jobDataSchema = z.object({
  deliveryId: z.uuid(),
}).strict();

export type DeliveryWorkerResources = {
  worker: Worker<DeliveryJobData>;
  connection: RedisClient;
  close(): Promise<void>;
};

export type DeliveryWorkerOptions = {
  requestTimeoutMs?: number | undefined;
  retryPolicy?: DeliveryRetryPolicy | undefined;
};

type ProcessDeliveryOptions = DeliveryWorkerOptions & {
  currentAttempt?: number | undefined;
  totalAttempts?: number | undefined;
};

class WebhookRequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Webhook request exceeded the ${timeoutMs} ms timeout.`);
    this.name = "WebhookRequestTimeoutError";
  }
}

async function persistFailedDelivery(
  db: AppDatabase,
  deliveryId: string,
  classification: Exclude<DeliveryResultClassification, "success">,
  currentAttempt: number,
  totalAttempts: number,
  retryPolicy: DeliveryRetryPolicy,
): Promise<void> {
  const retryDelayMs =
    classification === "retryable" && currentAttempt < totalAttempts
      ? getRetryDelayMs(currentAttempt, retryPolicy)
      : undefined;

  await db
    .update(deliveries)
    .set({
      status: retryDelayMs === undefined ? "queued" : "retry_scheduled",
      nextAttemptAt:
        retryDelayMs === undefined ? null : new Date(Date.now() + retryDelayMs),
      deliveredAt: null,
    })
    .where(
      and(eq(deliveries.id, deliveryId), eq(deliveries.status, "delivering")),
    );
}

async function sendWebhook(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref();

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new WebhookRequestTimeoutError(timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function processDelivery(
  db: AppDatabase,
  data: unknown,
  options: ProcessDeliveryOptions = {},
): Promise<void> {
  const retryPolicy = options.retryPolicy ?? PRODUCTION_RETRY_POLICY;
  const currentAttempt = options.currentAttempt ?? 1;
  const totalAttempts = options.totalAttempts ?? retryPolicy.maxAttempts;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_WEBHOOK_TIMEOUT_MS;
  const parsed = jobDataSchema.safeParse(data);
  if (!parsed.success) {
    throw new UnrecoverableError(
      "Delivery job data must contain a valid deliveryId UUID.",
    );
  }

  const [canonical] = await db
    .select({
      deliveryId: deliveries.id,
      deliveryStatus: deliveries.status,
      eventId: events.id,
      eventType: events.eventType,
      payload: events.payload,
      endpointUrl: webhookEndpoints.url,
      signingSecret: webhookEndpoints.signingSecret,
    })
    .from(deliveries)
    .innerJoin(events, eq(events.id, deliveries.eventId))
    .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, deliveries.endpointId))
    .where(eq(deliveries.id, parsed.data.deliveryId))
    .limit(1);

  if (!canonical) {
    throw new UnrecoverableError(
      `Delivery ${parsed.data.deliveryId} or its related event/endpoint was not found.`,
    );
  }

  if (canonical.deliveryStatus === "delivered") {
    return;
  }

  await db
    .update(deliveries)
    .set({ status: "delivering", nextAttemptAt: null })
    .where(eq(deliveries.id, canonical.deliveryId));

  const rawBody = serializeJsonDeterministically(canonical.payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createWebhookSignature(
    canonical.signingSecret,
    timestamp,
    rawBody,
  );

  let response: Response;
  try {
    response = await sendWebhook(
      canonical.endpointUrl,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hookrelay-event-id": canonical.eventId,
          "x-hookrelay-event-type": canonical.eventType,
          "x-hookrelay-timestamp": timestamp,
          "x-hookrelay-signature": signature,
        },
        body: rawBody,
      },
      requestTimeoutMs,
    );
  } catch (error) {
    const classification = classifyDeliveryResult(
      error instanceof WebhookRequestTimeoutError ? "timeout" : "network",
    );
    if (classification !== "retryable") {
      throw new Error("Network and timeout failures must be retryable.");
    }
    await persistFailedDelivery(
      db,
      canonical.deliveryId,
      classification,
      currentAttempt,
      totalAttempts,
      retryPolicy,
    );
    const message =
      error instanceof Error ? error.message : "Unknown delivery network error";
    throw new Error(`Delivery ${canonical.deliveryId} failed: ${message}`, {
      cause: error,
    });
  }

  const classification = classifyDeliveryResult("http", response.status);
  if (classification !== "success") {
    await persistFailedDelivery(
      db,
      canonical.deliveryId,
      classification,
      currentAttempt,
      totalAttempts,
      retryPolicy,
    );
    const message = `Delivery ${canonical.deliveryId} failed: Endpoint returned HTTP ${response.status}.`;
    if (classification === "terminal") {
      throw new UnrecoverableError(message);
    }
    throw new Error(message);
  }

  await db
    .update(deliveries)
    .set({
      status: "delivered",
      deliveredAt: new Date(),
      nextAttemptAt: null,
    })
    .where(eq(deliveries.id, canonical.deliveryId));
}

export function createDeliveryWorker(
  db: AppDatabase,
  redisUrl: string,
  options: DeliveryWorkerOptions = {},
): DeliveryWorkerResources {
  const retryPolicy = options.retryPolicy ?? PRODUCTION_RETRY_POLICY;
  const connection = createBullWorkerRedisClient(redisUrl);
  const worker = new Worker<DeliveryJobData>(
    DELIVERY_QUEUE_NAME,
    async (job) =>
      processDelivery(db, job.data, {
        currentAttempt: job.attemptsMade + 1,
        totalAttempts: job.opts.attempts,
        requestTimeoutMs: options.requestTimeoutMs,
        retryPolicy,
      }),
    {
      connection,
      settings: {
        backoffStrategy: (attemptsMade, type) => {
          if (type !== DELIVERY_BACKOFF_STRATEGY) return -1;
          return getRetryDelayMs(attemptsMade, retryPolicy) ?? -1;
        },
      },
    },
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
