import { performance } from "node:perf_hooks";
import { eq } from "drizzle-orm";
import { UnrecoverableError, Worker } from "bullmq";
import { z } from "zod";
import type { AppDatabase } from "../db/client.js";
import { deliveries, events, webhookEndpoints } from "../db/schema.js";
import { serializeJsonDeterministically } from "../domain/ingestion.js";
import { normalizeDeliveryAttemptResult } from "../domain/delivery-attempt-result.js";
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
  getRetryDelayMs,
  PRODUCTION_RETRY_POLICY,
  type DeliveryRetryPolicy,
} from "../retry/delivery-retry-policy.js";
import {
  finalizeDeliveryAttempt,
  startDeliveryAttempt,
  type DeliveryAttemptFinalization,
  type StartedDeliveryAttempt,
} from "./delivery-attempt-store.js";

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

function createFailureFinalization(
  result: ReturnType<typeof normalizeDeliveryAttemptResult>,
  currentAttempt: number,
  totalAttempts: number,
  retryPolicy: DeliveryRetryPolicy,
): DeliveryAttemptFinalization {
  const retryDelayMs =
    result.classification === "retryable" && currentAttempt < totalAttempts
      ? getRetryDelayMs(currentAttempt, retryPolicy)
      : undefined;
  const completedAt = new Date();
  return {
    completedAt,
    responseStatus: result.responseStatus,
    latencyMs: result.latencyMs,
    errorMessage: result.errorMessage,
    deliveryStatus:
      retryDelayMs === undefined ? "dead_letter" : "retry_scheduled",
    nextAttemptAt:
      retryDelayMs === undefined
        ? null
        : new Date(completedAt.getTime() + retryDelayMs),
    deliveredAt: null,
  };
}

async function persistFailure(
  db: AppDatabase,
  attempt: StartedDeliveryAttempt,
  result: ReturnType<typeof normalizeDeliveryAttemptResult>,
  currentAttempt: number,
  totalAttempts: number,
  retryPolicy: DeliveryRetryPolicy,
): Promise<void> {
  await finalizeDeliveryAttempt(
    db,
    attempt,
    createFailureFinalization(
      result,
      currentAttempt,
      totalAttempts,
      retryPolicy,
    ),
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

  if (
    canonical.deliveryStatus === "delivered" ||
    canonical.deliveryStatus === "dead_letter"
  ) {
    return;
  }

  const attempt = await startDeliveryAttempt(db, canonical.deliveryId);
  if (!attempt) return;

  const rawBody = serializeJsonDeterministically(canonical.payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createWebhookSignature(
    canonical.signingSecret,
    timestamp,
    rawBody,
  );

  let response: Response;
  const requestStartedAt = performance.now();
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
    const result = normalizeDeliveryAttemptResult(
      error instanceof WebhookRequestTimeoutError
        ? { kind: "timeout", elapsedMs: performance.now() - requestStartedAt }
        : {
            kind: "network",
            elapsedMs: performance.now() - requestStartedAt,
            error,
          },
    );
    await persistFailure(
      db,
      attempt,
      result,
      currentAttempt,
      totalAttempts,
      retryPolicy,
    );
    const message = result.errorMessage ?? "Unknown delivery network error";
    throw new Error(`Delivery ${canonical.deliveryId} failed: ${message}`, {
      cause: error,
    });
  }

  const result = normalizeDeliveryAttemptResult({
    kind: "http",
    statusCode: response.status,
    elapsedMs: performance.now() - requestStartedAt,
  });
  if (result.classification !== "success") {
    await persistFailure(
      db,
      attempt,
      result,
      currentAttempt,
      totalAttempts,
      retryPolicy,
    );
    const message = `Delivery ${canonical.deliveryId} failed: ${result.errorMessage}.`;
    if (result.classification === "terminal") {
      throw new UnrecoverableError(message);
    }
    throw new Error(message);
  }

  const completedAt = new Date();
  await finalizeDeliveryAttempt(db, attempt, {
    completedAt,
    responseStatus: result.responseStatus,
    latencyMs: result.latencyMs,
    errorMessage: result.errorMessage,
    deliveryStatus: "delivered",
    deliveredAt: completedAt,
    nextAttemptAt: null,
  });
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
