import { createServer, type Server } from "node:http";
import { createServer as createTcpServer, connect, type Server as TcpServer, type Socket } from "node:net";
import { resolve } from "node:path";
import { asc, count, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { FastifyInstance } from "fastify";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/api/app.js";
import {
  createDemoReceiver,
  type DemoReceiverResources,
} from "../../src/demo-receiver/app.js";
import { createDatabase, type DatabaseResources } from "../../src/db/client.js";
import {
  deliveries,
  deliveryAttempts,
  events,
  webhookEndpoints,
} from "../../src/db/schema.js";
import {
  createDeliveryQueue,
  type DeliveryQueueResources,
} from "../../src/queue/delivery-queue.js";
import {
  createDeliveryWorker,
  processDelivery,
  type DeliveryWorkerResources,
} from "../../src/worker/delivery-worker.js";
import { createWebhookSignature } from "../../src/signing/webhook-signature.js";
import {
  createDeliveryRetryPolicy,
  type DeliveryRetryPolicy,
} from "../../src/retry/delivery-retry-policy.js";
import { startDeliveryAttempt } from "../../src/worker/delivery-attempt-store.js";

const adminDatabaseUrl =
  process.env.HOOKRELAY_TEST_ADMIN_DATABASE_URL ??
  "postgresql://hookrelay:hookrelay@127.0.0.1:5432/postgres";
const redisUrl = process.env.HOOKRELAY_TEST_REDIS_URL ?? "redis://127.0.0.1:6379";
const testDatabaseName = "hookrelay_queue_test";

function databaseUrlFor(databaseName: string): string {
  const url = new URL(adminDatabaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function ensureTestDatabase(): Promise<void> {
  const admin = postgres(adminDatabaseUrl, { max: 1 });
  try {
    const existing = await admin<{ exists: boolean }[]>`
      select exists(
        select 1 from pg_database where datname = ${testDatabaseName}
      ) as exists
    `;
    if (!existing[0]?.exists) {
      await admin.unsafe(`create database "${testDatabaseName}"`);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
}

async function waitFor<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean | Promise<boolean>,
  timeoutMs = 8_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  let accepted = await accept(value);

  while (!accepted && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    value = await read();
    accepted = await accept(value);
  }

  if (!accepted) throw new Error("Timed out waiting for integration state.");
  return value;
}

class RedisTcpProxy {
  private server: TcpServer | undefined;
  private readonly sockets = new Set<Socket>();
  private port = 0;

  get url(): string {
    if (this.port === 0) throw new Error("Redis proxy has not been started.");
    return `redis://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    this.server = createTcpServer((client) => {
      const upstream = connect({ host: "127.0.0.1", port: 6379 });
      this.sockets.add(client);
      this.sockets.add(upstream);

      const closePair = () => {
        client.destroy();
        upstream.destroy();
      };
      client.on("error", closePair);
      upstream.on("error", closePair);
      client.on("close", () => this.sockets.delete(client));
      upstream.on("close", () => this.sockets.delete(upstream));
      client.pipe(upstream);
      upstream.pipe(client);
    });
    this.server.on("error", () => undefined);

    await new Promise<void>((resolveListen, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.port, "127.0.0.1", () => {
        const address = this.server?.address();
        if (typeof address === "object" && address) this.port = address.port;
        resolveListen();
      });
    });
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = undefined;
    if (!server?.listening) return;
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
}

describe("Task 3-6 BullMQ delivery pipeline", () => {
  let database: DatabaseResources;
  let receiver: Server;
  let receiverUrl: string;
  let receiverStatus = 204;
  let receiverStatusSequence: number[] = [];
  let receiverResponseDelayMs = 0;
  let receivedBodies: unknown[] = [];
  let receivedEventIds: string[] = [];
  let demoReceiver: DemoReceiverResources;
  let demoReceiverUrl: string;
  let app: FastifyInstance | undefined;
  let queue: DeliveryQueueResources | undefined;
  let worker: DeliveryWorkerResources | undefined;

  beforeAll(async () => {
    await ensureTestDatabase();
    database = createDatabase(databaseUrlFor(testDatabaseName));
    await migrate(database.db, {
      migrationsFolder: resolve(process.cwd(), "drizzle"),
    });

    receiver = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const requestIndex = receivedBodies.length;
        receivedBodies.push(JSON.parse(body));
        receivedEventIds.push(String(request.headers["x-hookrelay-event-id"] ?? ""));
        const status = receiverStatusSequence[requestIndex] ?? receiverStatus;
        const sendResponse = () => {
          if (!response.destroyed) response.writeHead(status).end();
        };
        if (receiverResponseDelayMs > 0) {
          setTimeout(sendResponse, receiverResponseDelayMs);
        } else {
          sendResponse();
        }
      });
    });
    await new Promise<void>((resolveListen) => {
      receiver.listen(0, "127.0.0.1", () => resolveListen());
    });
    const address = receiver.address();
    if (typeof address !== "object" || !address) {
      throw new Error("HTTP test receiver did not expose an address.");
    }
    receiverUrl = `http://127.0.0.1:${address.port}/webhook`;

    demoReceiver = createDemoReceiver({
      secret: "task4-demo-secret",
      maxAgeSeconds: 300,
    });
    demoReceiverUrl = await demoReceiver.app.listen({
      port: 0,
      host: "127.0.0.1",
    });
  }, 15_000);

  beforeEach(async () => {
    receiverStatus = 204;
    receiverStatusSequence = [];
    receiverResponseDelayMs = 0;
    receivedBodies = [];
    receivedEventIds = [];
    await database.client.unsafe(
      "truncate table delivery_attempts, deliveries, events, webhook_endpoints cascade",
    );
    const maintenanceQueue = createDeliveryQueue(redisUrl);
    await maintenanceQueue.queue.obliterate({ force: true });
    await maintenanceQueue.close();
  });

  afterEach(async () => {
    await worker?.close();
    await app?.close();
    await queue?.close();
    worker = undefined;
    app = undefined;
    queue = undefined;
  });

  afterAll(async () => {
    await new Promise<void>((resolveClose) => receiver.close(() => resolveClose()));
    await demoReceiver.app.close();
    await database.client.end({ timeout: 5 });
  });

  async function startRuntime(
    options: {
      producerRedisUrl?: string;
      requestTimeoutMs?: number;
      retryPolicy?: DeliveryRetryPolicy;
    } = {},
  ): Promise<void> {
    queue = createDeliveryQueue(options.producerRedisUrl ?? redisUrl);
    await queue.queue.waitUntilReady();
    worker = createDeliveryWorker(database.db, redisUrl, {
      requestTimeoutMs: options.requestTimeoutMs,
      retryPolicy:
        options.retryPolicy ?? createDeliveryRetryPolicy([20, 20, 20, 20]),
    });
    await worker.worker.waitUntilReady();
    app = buildApp({
      database: database.db,
      deliveryScheduler: queue,
      dependencyChecks: {
        postgres: async () => undefined,
        redis: async () => undefined,
      },
    });
  }

  async function createEndpoint(
    options: { url?: string; signingSecret?: string } = {},
  ): Promise<string> {
    const response = await app?.inject({
      method: "POST",
      url: "/endpoints",
      payload: {
        name: "Task 3 receiver",
        url: options.url ?? receiverUrl,
        signingSecret: options.signingSecret ?? "task3-receiver-secret",
      },
    });
    expect(response?.statusCode).toBe(201);
    return response?.json().endpoint.id as string;
  }

  function ingest(endpointId: string, key: string) {
    return app?.inject({
      method: "POST",
      url: "/events",
      headers: { "idempotency-key": key },
      payload: {
        endpointId,
        eventType: "order.created",
        payload: { metadata: { b: 2, a: 1 }, orderId: 123 },
      },
    });
  }

  async function readDelivery(deliveryId: string) {
    const [delivery] = await database.db
      .select()
      .from(deliveries)
      .where(eq(deliveries.id, deliveryId));
    return delivery;
  }

  function readAttempts(deliveryId: string) {
    return database.db
      .select()
      .from(deliveryAttempts)
      .where(eq(deliveryAttempts.deliveryId, deliveryId))
      .orderBy(asc(deliveryAttempts.attemptNumber));
  }

  async function createPersistedDelivery(key: string): Promise<string> {
    const [endpoint] = await database.db
      .insert(webhookEndpoints)
      .values({
        name: "Attempt persistence fixture",
        url: receiverUrl,
        signingSecret: "task6-persistence-secret",
      })
      .returning({ id: webhookEndpoints.id });
    const [event] = await database.db
      .insert(events)
      .values({
        eventType: "attempt.persistence",
        payload: { fixture: true },
        idempotencyKey: key,
      })
      .returning({ id: events.id });
    if (!endpoint || !event) throw new Error("Failed to create attempt fixture.");
    const [delivery] = await database.db
      .insert(deliveries)
      .values({ eventId: event.id, endpointId: endpoint.id })
      .returning({ id: deliveries.id });
    if (!delivery) throw new Error("Failed to create delivery fixture.");
    return delivery.id;
  }

  it("delivers the canonical payload and deduplicates repeated scheduling", async () => {
    await startRuntime();
    const endpointId = await createEndpoint();
    const first = await ingest(endpointId, "task3-success-duplicate");
    expect(first?.statusCode).toBe(201);
    const firstBody = first?.json();

    const delivered = await waitFor(
      () => readDelivery(firstBody.delivery.id),
      (value) => value?.status === "delivered",
    );
    expect(receivedBodies).toEqual([{ metadata: { a: 1, b: 2 }, orderId: 123 }]);
    expect(delivered?.deliveredAt).toBeInstanceOf(Date);
    expect(delivered?.attemptCount).toBe(1);
    expect(await readAttempts(firstBody.delivery.id)).toMatchObject([
      {
        attemptNumber: 1,
        responseStatus: 204,
        completedAt: expect.any(Date),
        latencyMs: expect.any(Number),
        errorMessage: null,
      },
    ]);

    const job = await queue?.queue.getJob(firstBody.delivery.id);
    expect(job?.id).toBe(firstBody.delivery.id);
    expect(job?.data).toEqual({ deliveryId: firstBody.delivery.id });
    expect(await job?.getState()).toBe("completed");

    const duplicate = await ingest(endpointId, "task3-success-duplicate");
    expect(duplicate?.statusCode).toBe(200);
    expect(duplicate?.json().event.id).toBe(firstBody.event.id);
    expect(duplicate?.json().delivery.id).toBe(firstBody.delivery.id);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(receivedBodies).toHaveLength(1);

    await processDelivery(database.db, { deliveryId: firstBody.delivery.id });
    expect(receivedBodies).toHaveLength(1);
    expect(await readAttempts(firstBody.delivery.id)).toHaveLength(1);

    const [eventCount] = await database.db.select({ value: count() }).from(events);
    const [deliveryCount] = await database.db.select({ value: count() }).from(deliveries);
    expect(eventCount?.value).toBe(1);
    expect(deliveryCount?.value).toBe(1);
  }, 15_000);

  it("preserves incomplete attempts and allocates a new durable number", async () => {
    const deliveryId = await createPersistedDelivery("task6-incomplete-attempt");
    const first = await startDeliveryAttempt(database.db, deliveryId);
    const second = await startDeliveryAttempt(database.db, deliveryId);

    expect(first?.attemptNumber).toBe(1);
    expect(second?.attemptNumber).toBe(2);
    const delivery = await readDelivery(deliveryId);
    expect(delivery?.attemptCount).toBe(2);
    const attempts = await readAttempts(deliveryId);
    expect(attempts.map((attempt) => attempt.attemptNumber)).toEqual([1, 2]);
    expect(attempts).toEqual([
      expect.objectContaining({
        id: first?.id,
        startedAt: expect.any(Date),
        completedAt: null,
        responseStatus: null,
        latencyMs: null,
        errorMessage: null,
      }),
      expect.objectContaining({
        id: second?.id,
        startedAt: expect.any(Date),
        completedAt: null,
        responseStatus: null,
        latencyMs: null,
        errorMessage: null,
      }),
    ]);

    await expect(
      database.db.insert(deliveryAttempts).values({
        deliveryId,
        attemptNumber: 1,
      }),
    ).rejects.toThrow();
    expect(await readAttempts(deliveryId)).toHaveLength(2);
  });

  it("rejects malformed job identity before loading delivery data", async () => {
    await expect(
      processDelivery(database.db, { deliveryId: "not-a-uuid" }),
    ).rejects.toThrow("valid deliveryId UUID");
  });

  it("resolves concurrent ingestions to one job and one outbound request", async () => {
    await startRuntime();
    const endpointId = await createEndpoint();
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => ingest(endpointId, "task3-concurrent")),
    );
    expect(responses.filter((response) => response?.statusCode === 201)).toHaveLength(1);
    expect(responses.filter((response) => response?.statusCode === 200)).toHaveLength(7);

    const deliveryIds = new Set(responses.map((response) => response?.json().delivery.id));
    expect(deliveryIds.size).toBe(1);
    const deliveryId = [...deliveryIds][0] as string;
    await waitFor(() => readDelivery(deliveryId), (value) => value?.status === "delivered");
    expect(receivedBodies).toHaveLength(1);

    const [eventCount] = await database.db.select({ value: count() }).from(events);
    const [deliveryCount] = await database.db.select({ value: count() }).from(deliveries);
    expect(eventCount?.value).toBe(1);
    expect(deliveryCount?.value).toBe(1);
  }, 15_000);

  it("preserves durable work across a producer Redis outage and schedules it after recovery", async () => {
    const proxy = new RedisTcpProxy();
    await proxy.start();
    try {
      await startRuntime({ producerRedisUrl: proxy.url });
      const endpointId = await createEndpoint();
      await proxy.stop();

      const unavailable = await ingest(endpointId, "task3-redis-recovery");
      expect(unavailable?.statusCode).toBe(503);
      expect(unavailable?.json()).toMatchObject({
        durableAccepted: true,
        scheduled: false,
        reused: false,
        error: { code: "delivery_scheduling_unavailable" },
      });
      const accepted = unavailable?.json();

      const [eventCount] = await database.db.select({ value: count() }).from(events);
      const [deliveryCount] = await database.db.select({ value: count() }).from(deliveries);
      expect(eventCount?.value).toBe(1);
      expect(deliveryCount?.value).toBe(1);

      await proxy.start();
      const recovered = await waitFor(
        async () => ingest(endpointId, "task3-redis-recovery"),
        (response) => response?.statusCode === 200,
      );
      expect(recovered?.json()).toMatchObject({
        reused: true,
        event: { id: accepted.event.id },
        delivery: { id: accepted.delivery.id },
      });

      await waitFor(
        () => readDelivery(accepted.delivery.id),
        (value) => value?.status === "delivered",
      );
      expect(receivedBodies).toHaveLength(1);
    } finally {
      await proxy.stop();
    }
  }, 20_000);

  it("exhausts an always-500 delivery after exactly five attempts", async () => {
    receiverStatus = 500;
    await startRuntime();
    const endpointId = await createEndpoint();
    const response = await ingest(endpointId, "task5-http-exhausted");
    expect(response?.statusCode).toBe(201);
    const deliveryId = response?.json().delivery.id as string;

    const failedJob = await waitFor(
      () => queue!.queue.getJob(deliveryId),
      async (job) => (job ? (await job.getState()) === "failed" : false),
    );
    expect(await failedJob?.getState()).toBe("failed");
    expect(failedJob?.attemptsMade).toBe(5);
    expect(failedJob?.opts.attempts).toBe(5);
    expect(failedJob?.opts.backoff).toEqual({
      type: "hookrelay-delivery-retry",
    });
    expect(failedJob?.id).toBe(deliveryId);

    const delivery = await readDelivery(deliveryId);
    expect(delivery?.status).toBe("dead_letter");
    expect(delivery?.deliveredAt).toBeNull();
    expect(delivery?.nextAttemptAt).toBeNull();
    expect(delivery?.attemptCount).toBe(5);
    const attempts = await readAttempts(deliveryId);
    expect(attempts.map((attempt) => attempt.attemptNumber)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    for (const attempt of attempts) {
      expect(attempt).toMatchObject({
        deliveryId,
        responseStatus: 500,
        completedAt: expect.any(Date),
        latencyMs: expect.any(Number),
        errorMessage: "HTTP 500",
      });
      expect(attempt.latencyMs).toBeGreaterThanOrEqual(0);
    }
    expect(receivedBodies).toHaveLength(5);
    expect(new Set(receivedEventIds)).toEqual(new Set([response?.json().event.id]));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(receivedBodies).toHaveLength(5);
  }, 15_000);

  it("delivers a signed webhook end to end through the demo receiver", async () => {
    await startRuntime();
    const scenario = "task4-signed-success";
    const endpointId = await createEndpoint({
      url: `${demoReceiverUrl}/demo/webhook?scenario=${scenario}&fail_first=0`,
      signingSecret: "task4-demo-secret",
    });
    const response = await ingest(endpointId, "task4-signed-success");
    expect(response?.statusCode).toBe(201);
    const accepted = response?.json();

    const delivered = await waitFor(
      () => readDelivery(accepted.delivery.id),
      (value) => value?.status === "delivered",
    );
    const state = demoReceiver.getScenarioState(scenario);
    expect(state?.validRequestCount).toBe(1);
    expect(state?.lastRequest).toMatchObject({
      eventId: accepted.event.id,
      eventType: "order.created",
      rawBody: '{"metadata":{"a":1,"b":2},"orderId":123}',
      payload: { metadata: { a: 1, b: 2 }, orderId: 123 },
    });
    expect(state?.lastRequest.timestamp).toMatch(/^[0-9]+$/);
    expect(delivered?.deliveredAt).toBeInstanceOf(Date);
    expect(delivered?.attemptCount).toBe(1);
    const attempts = await readAttempts(accepted.delivery.id);
    expect(attempts).toMatchObject([
      {
        attemptNumber: 1,
        responseStatus: 200,
        completedAt: expect.any(Date),
        errorMessage: null,
      },
    ]);
    expect(attempts[0]?.latencyMs).toBeGreaterThanOrEqual(0);
  }, 15_000);

  it("automatically retries signed 500, 500, 200 responses on one identity", async () => {
    await startRuntime({
      retryPolicy: createDeliveryRetryPolicy([1_050, 1_050, 20, 20]),
    });
    const scenario = "task5-signed-retry-success";
    const endpointId = await createEndpoint({
      url: `${demoReceiverUrl}/demo/webhook?scenario=${scenario}&fail_first=2`,
      signingSecret: "task4-demo-secret",
    });
    const response = await ingest(endpointId, "task5-signed-retry-success");
    expect(response?.statusCode).toBe(201);
    const accepted = response?.json();

    const delivered = await waitFor(
      () => readDelivery(accepted.delivery.id),
      (value) => value?.status === "delivered",
    );
    const state = demoReceiver.getScenarioState(scenario);
    expect(state?.responseStatuses).toEqual([500, 500, 200]);
    expect(state?.validRequestCount).toBe(3);
    expect(state?.requests.map((request) => request.eventId)).toEqual([
      accepted.event.id,
      accepted.event.id,
      accepted.event.id,
    ]);
    expect(state?.requests.map((request) => request.rawBody)).toEqual([
      '{"metadata":{"a":1,"b":2},"orderId":123}',
      '{"metadata":{"a":1,"b":2},"orderId":123}',
      '{"metadata":{"a":1,"b":2},"orderId":123}',
    ]);
    expect(new Set(state?.requests.map((request) => request.timestamp)).size).toBe(3);
    expect(delivered?.deliveredAt).toBeInstanceOf(Date);
    expect(delivered?.nextAttemptAt).toBeNull();
    expect(delivered?.attemptCount).toBe(3);

    const job = await queue?.queue.getJob(accepted.delivery.id);
    expect(job?.id).toBe(accepted.delivery.id);
    expect(job?.attemptsMade).toBe(3);
    expect(await job?.getState()).toBe("completed");

    const [eventCount] = await database.db.select({ value: count() }).from(events);
    const [deliveryCount] = await database.db.select({ value: count() }).from(deliveries);
    const attempts = await readAttempts(accepted.delivery.id);
    expect(eventCount?.value).toBe(1);
    expect(deliveryCount?.value).toBe(1);
    expect(attempts.map((attempt) => attempt.attemptNumber)).toEqual([1, 2, 3]);
    expect(attempts.map((attempt) => attempt.responseStatus)).toEqual([
      500,
      500,
      200,
    ]);
    expect(attempts.map((attempt) => attempt.errorMessage)).toEqual([
      "HTTP 500",
      "HTTP 500",
      null,
    ]);
    for (const attempt of attempts) {
      expect(attempt.completedAt).toBeInstanceOf(Date);
      expect(attempt.latencyMs).toBeGreaterThanOrEqual(0);
    }
  }, 15_000);

  it("persists retry_scheduled and the shared expected next-attempt delay", async () => {
    const retryDelayMs = 600;
    await startRuntime({
      retryPolicy: createDeliveryRetryPolicy([retryDelayMs, 20, 20, 20]),
    });
    const scenario = "task5-visible-retry-state";
    const endpointId = await createEndpoint({
      url: `${demoReceiverUrl}/demo/webhook?scenario=${scenario}&fail_first=1`,
      signingSecret: "task4-demo-secret",
    });
    const response = await ingest(endpointId, "task5-visible-retry-state");
    const deliveryId = response?.json().delivery.id as string;

    const retryScheduled = await waitFor(
      () => readDelivery(deliveryId),
      (value) => value?.status === "retry_scheduled",
    );
    expect(retryScheduled?.nextAttemptAt).toBeInstanceOf(Date);
    const remainingDelayMs = retryScheduled!.nextAttemptAt!.getTime() - Date.now();
    expect(remainingDelayMs).toBeGreaterThan(300);
    expect(remainingDelayMs).toBeLessThanOrEqual(retryDelayMs + 100);
    expect(retryScheduled?.attemptCount).toBe(1);
    expect(await readAttempts(deliveryId)).toMatchObject([
      {
        attemptNumber: 1,
        responseStatus: 500,
        completedAt: expect.any(Date),
        errorMessage: "HTTP 500",
      },
    ]);
    const delayedJob = await queue?.queue.getJob(deliveryId);
    expect(await delayedJob?.getState()).toBe("delayed");

    const delivered = await waitFor(
      () => readDelivery(deliveryId),
      (value) => value?.status === "delivered",
    );
    expect(delivered?.nextAttemptAt).toBeNull();
    expect(delivered?.attemptCount).toBe(2);
    expect(demoReceiver.getScenarioState(scenario)?.responseStatuses).toEqual([
      500,
      200,
    ]);
  }, 15_000);

  it("fails an HTTP 400 terminal response without consuming retries", async () => {
    receiverStatus = 400;
    await startRuntime();
    const endpointId = await createEndpoint();
    const response = await ingest(endpointId, "task5-terminal-400");
    const deliveryId = response?.json().delivery.id as string;

    const failedJob = await waitFor(
      () => queue!.queue.getJob(deliveryId),
      async (job) => (job ? (await job.getState()) === "failed" : false),
    );
    expect(failedJob?.attemptsMade).toBe(1);
    expect(failedJob?.opts.attempts).toBe(5);
    const delivery = await readDelivery(deliveryId);
    expect(delivery?.status).toBe("dead_letter");
    expect(delivery?.deliveredAt).toBeNull();
    expect(delivery?.nextAttemptAt).toBeNull();
    expect(delivery?.attemptCount).toBe(1);
    const attempts = await readAttempts(deliveryId);
    expect(attempts).toMatchObject([
      {
        attemptNumber: 1,
        responseStatus: 400,
        completedAt: expect.any(Date),
        errorMessage: "HTTP 400",
      },
    ]);
    expect(attempts[0]?.latencyMs).toBeGreaterThanOrEqual(0);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(receivedBodies).toHaveLength(1);
  }, 15_000);

  it("retries HTTP 429 once and then delivers on HTTP 200", async () => {
    receiverStatusSequence = [429, 200];
    await startRuntime();
    const endpointId = await createEndpoint();
    const response = await ingest(endpointId, "task5-retry-429");
    const accepted = response?.json();

    const delivered = await waitFor(
      () => readDelivery(accepted.delivery.id),
      (value) => value?.status === "delivered",
    );
    expect(receivedBodies).toHaveLength(2);
    expect(receivedEventIds).toEqual([accepted.event.id, accepted.event.id]);
    expect(delivered?.nextAttemptAt).toBeNull();
    expect(delivered?.attemptCount).toBe(2);
    const attempts = await readAttempts(accepted.delivery.id);
    expect(attempts.map((attempt) => attempt.attemptNumber)).toEqual([1, 2]);
    expect(attempts.map((attempt) => attempt.responseStatus)).toEqual([429, 200]);
    expect(attempts.map((attempt) => attempt.errorMessage)).toEqual([
      "HTTP 429",
      null,
    ]);
    const job = await queue?.queue.getJob(accepted.delivery.id);
    expect(job?.attemptsMade).toBe(2);
    expect(await job?.getState()).toBe("completed");
  }, 15_000);

  it("aborts slow requests and exhausts timeout retries at five attempts", async () => {
    receiverResponseDelayMs = 100;
    await startRuntime({
      requestTimeoutMs: 15,
      retryPolicy: createDeliveryRetryPolicy([10, 10, 10, 10]),
    });
    const endpointId = await createEndpoint();
    const response = await ingest(endpointId, "task5-timeout-exhausted");
    const deliveryId = response?.json().delivery.id as string;

    const failedJob = await waitFor(
      () => queue!.queue.getJob(deliveryId),
      async (job) => (job ? (await job.getState()) === "failed" : false),
    );
    expect(failedJob?.attemptsMade).toBe(5);
    expect(receivedBodies).toHaveLength(5);
    const delivery = await readDelivery(deliveryId);
    expect(delivery?.status).toBe("dead_letter");
    expect(delivery?.deliveredAt).toBeNull();
    expect(delivery?.nextAttemptAt).toBeNull();
    expect(delivery?.attemptCount).toBe(5);
    const attempts = await readAttempts(deliveryId);
    expect(attempts.map((attempt) => attempt.attemptNumber)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    for (const attempt of attempts) {
      expect(attempt.responseStatus).toBeNull();
      expect(attempt.completedAt).toBeInstanceOf(Date);
      expect(attempt.latencyMs).toBeGreaterThanOrEqual(0);
      expect(attempt.errorMessage).toBe("Webhook request timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(receivedBodies).toHaveLength(5);
  }, 15_000);

  it("persists normalized network failures without an HTTP status", async () => {
    const closedPortServer = createServer();
    await new Promise<void>((resolveListen) => {
      closedPortServer.listen(0, "127.0.0.1", () => resolveListen());
    });
    const closedAddress = closedPortServer.address();
    if (typeof closedAddress !== "object" || !closedAddress) {
      throw new Error("Closed-port fixture did not expose an address.");
    }
    await new Promise<void>((resolveClose) =>
      closedPortServer.close(() => resolveClose()),
    );

    await startRuntime({
      retryPolicy: createDeliveryRetryPolicy([10, 10, 10, 10]),
    });
    const endpointId = await createEndpoint({
      url: `http://127.0.0.1:${closedAddress.port}/webhook`,
    });
    const response = await ingest(endpointId, "task6-network-exhausted");
    const deliveryId = response?.json().delivery.id as string;

    const failedJob = await waitFor(
      () => queue!.queue.getJob(deliveryId),
      async (job) => (job ? (await job.getState()) === "failed" : false),
    );
    expect(failedJob?.attemptsMade).toBe(5);
    const delivery = await readDelivery(deliveryId);
    expect(delivery).toMatchObject({
      status: "dead_letter",
      attemptCount: 5,
      deliveredAt: null,
      nextAttemptAt: null,
    });
    const attempts = await readAttempts(deliveryId);
    expect(attempts).toHaveLength(5);
    for (const attempt of attempts) {
      expect(attempt.responseStatus).toBeNull();
      expect(attempt.completedAt).toBeInstanceOf(Date);
      expect(attempt.latencyMs).toBeGreaterThanOrEqual(0);
      expect(attempt.errorMessage).toMatch(/^Network error/);
    }
  }, 15_000);

  it("does not deliver when the endpoint signing secret is wrong", async () => {
    await startRuntime();
    const scenario = "task4-wrong-secret";
    const endpointId = await createEndpoint({
      url: `${demoReceiverUrl}/demo/webhook?scenario=${scenario}&fail_first=0`,
      signingSecret: "wrong-endpoint-secret",
    });
    const response = await ingest(endpointId, "task4-wrong-secret");
    expect(response?.statusCode).toBe(201);
    const deliveryId = response?.json().delivery.id as string;

    const failedJob = await waitFor(
      () => queue!.queue.getJob(deliveryId),
      async (job) => (job ? (await job.getState()) === "failed" : false),
    );
    expect(await failedJob?.getState()).toBe("failed");
    expect(failedJob?.attemptsMade).toBe(1);
    const delivery = await readDelivery(deliveryId);
    expect(delivery?.status).toBe("dead_letter");
    expect(delivery?.deliveredAt).toBeNull();
    expect(delivery?.nextAttemptAt).toBeNull();
    expect(delivery?.attemptCount).toBe(1);
    expect(demoReceiver.getScenarioState(scenario)).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(demoReceiver.getScenarioState(scenario)).toBeUndefined();

    expect(await readAttempts(deliveryId)).toMatchObject([
      {
        attemptNumber: 1,
        responseStatus: 401,
        completedAt: expect.any(Date),
        errorMessage: "HTTP 401",
      },
    ]);
  }, 15_000);

  it("serves the controlled 500, 500, 200 boundary over real HTTP", async () => {
    const scenario = "task4-controlled-http";
    const rawBody = '{ "demo": true, "order": 123 }';
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const headersFor = (secret: string) => ({
      "content-type": "application/json",
      "x-hookrelay-event-id": "00000000-0000-4000-8000-000000000004",
      "x-hookrelay-event-type": "demo.controlled",
      "x-hookrelay-timestamp": timestamp,
      "x-hookrelay-signature": createWebhookSignature(secret, timestamp, rawBody),
    });
    const url = `${demoReceiverUrl}/demo/webhook?scenario=${scenario}&fail_first=2`;

    const invalid = await fetch(url, {
      method: "POST",
      headers: headersFor("wrong-secret"),
      body: rawBody,
    });
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetch(url, {
        method: "POST",
        headers: headersFor("task4-demo-secret"),
        body: rawBody,
      });
      statuses.push(response.status);
    }

    expect(invalid.status).toBe(401);
    expect(statuses).toEqual([500, 500, 200]);
    expect(demoReceiver.getScenarioState(scenario)).toMatchObject({
      validRequestCount: 3,
      lastRequest: { rawBody },
    });
  }, 15_000);

  it("leaves coherent delivered and dead-letter histories for database inspection", async () => {
    await startRuntime();
    const deliveredEndpointId = await createEndpoint({
      url: `${demoReceiverUrl}/demo/webhook?scenario=task6-db-delivered&fail_first=2`,
      signingSecret: "task4-demo-secret",
    });
    const deadLetterEndpointId = await createEndpoint({
      url: `${demoReceiverUrl}/demo/webhook?scenario=task6-db-dead-letter&fail_first=100`,
      signingSecret: "task4-demo-secret",
    });
    const deliveredResponse = await ingest(
      deliveredEndpointId,
      "task6-manual-db-delivered",
    );
    const deadLetterResponse = await ingest(
      deadLetterEndpointId,
      "task6-manual-db-dead-letter",
    );
    const deliveredId = deliveredResponse?.json().delivery.id as string;
    const deadLetterId = deadLetterResponse?.json().delivery.id as string;

    const delivered = await waitFor(
      () => readDelivery(deliveredId),
      (value) => value?.status === "delivered",
    );
    const deadLetter = await waitFor(
      () => readDelivery(deadLetterId),
      (value) => value?.status === "dead_letter",
    );
    expect(delivered).toMatchObject({
      status: "delivered",
      attemptCount: 3,
      nextAttemptAt: null,
    });
    expect(delivered?.deliveredAt).toBeInstanceOf(Date);
    expect(deadLetter).toMatchObject({
      status: "dead_letter",
      attemptCount: 5,
      deliveredAt: null,
      nextAttemptAt: null,
    });
    expect(
      (await readAttempts(deliveredId)).map((attempt) => attempt.responseStatus),
    ).toEqual([500, 500, 200]);
    expect(
      (await readAttempts(deadLetterId)).map(
        (attempt) => attempt.responseStatus,
      ),
    ).toEqual([500, 500, 500, 500, 500]);
  }, 15_000);
});
