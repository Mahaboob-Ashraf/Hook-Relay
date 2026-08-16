import { createServer, type Server } from "node:http";
import { createServer as createTcpServer, connect, type Server as TcpServer, type Socket } from "node:net";
import { resolve } from "node:path";
import { count, eq } from "drizzle-orm";
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
import { deliveries, deliveryAttempts, events } from "../../src/db/schema.js";
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

describe("Task 3-5 BullMQ delivery pipeline", () => {
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
    expect(delivered?.attemptCount).toBe(0);

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

    const [eventCount] = await database.db.select({ value: count() }).from(events);
    const [deliveryCount] = await database.db.select({ value: count() }).from(deliveries);
    expect(eventCount?.value).toBe(1);
    expect(deliveryCount?.value).toBe(1);
  }, 15_000);

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
    expect(delivery?.status).toBe("queued");
    expect(delivery?.deliveredAt).toBeNull();
    expect(delivery?.nextAttemptAt).toBeNull();
    expect(delivery?.attemptCount).toBe(0);
    const [attemptCount] = await database.db
      .select({ value: count() })
      .from(deliveryAttempts);
    expect(attemptCount?.value).toBe(0);
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
    expect(delivered?.attemptCount).toBe(0);

    const [attemptCount] = await database.db
      .select({ value: count() })
      .from(deliveryAttempts);
    expect(attemptCount?.value).toBe(0);
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
    expect(delivered?.attemptCount).toBe(0);

    const job = await queue?.queue.getJob(accepted.delivery.id);
    expect(job?.id).toBe(accepted.delivery.id);
    expect(job?.attemptsMade).toBe(3);
    expect(await job?.getState()).toBe("completed");

    const [eventCount] = await database.db.select({ value: count() }).from(events);
    const [deliveryCount] = await database.db.select({ value: count() }).from(deliveries);
    const [attemptCount] = await database.db
      .select({ value: count() })
      .from(deliveryAttempts);
    expect(eventCount?.value).toBe(1);
    expect(deliveryCount?.value).toBe(1);
    expect(attemptCount?.value).toBe(0);
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
    const delayedJob = await queue?.queue.getJob(deliveryId);
    expect(await delayedJob?.getState()).toBe("delayed");

    const delivered = await waitFor(
      () => readDelivery(deliveryId),
      (value) => value?.status === "delivered",
    );
    expect(delivered?.nextAttemptAt).toBeNull();
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
    expect(delivery?.status).toBe("queued");
    expect(delivery?.deliveredAt).toBeNull();
    expect(delivery?.nextAttemptAt).toBeNull();
    expect(delivery?.attemptCount).toBe(0);
    const [attemptCount] = await database.db
      .select({ value: count() })
      .from(deliveryAttempts);
    expect(attemptCount?.value).toBe(0);
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
    expect(delivery?.status).toBe("queued");
    expect(delivery?.deliveredAt).toBeNull();
    expect(delivery?.nextAttemptAt).toBeNull();
    expect(delivery?.attemptCount).toBe(0);
    const [attemptCount] = await database.db
      .select({ value: count() })
      .from(deliveryAttempts);
    expect(attemptCount?.value).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(receivedBodies).toHaveLength(5);
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
    expect(delivery?.status).toBe("queued");
    expect(delivery?.deliveredAt).toBeNull();
    expect(delivery?.attemptCount).toBe(0);
    expect(demoReceiver.getScenarioState(scenario)).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(demoReceiver.getScenarioState(scenario)).toBeUndefined();

    const [attemptCount] = await database.db
      .select({ value: count() })
      .from(deliveryAttempts);
    expect(attemptCount?.value).toBe(0);
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
});
