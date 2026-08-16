import { createServer, type Server } from "node:http";
import { createServer as createTcpServer, connect, type Server as TcpServer, type Socket } from "node:net";
import { resolve } from "node:path";
import { count, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { FastifyInstance } from "fastify";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/api/app.js";
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

describe("Task 3 BullMQ delivery pipeline", () => {
  let database: DatabaseResources;
  let receiver: Server;
  let receiverUrl: string;
  let receiverStatus = 204;
  let receivedBodies: unknown[] = [];
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
        receivedBodies.push(JSON.parse(body));
        response.writeHead(receiverStatus).end();
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
  }, 15_000);

  beforeEach(async () => {
    receiverStatus = 204;
    receivedBodies = [];
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
    await database.client.end({ timeout: 5 });
  });

  async function startRuntime(producerRedisUrl = redisUrl): Promise<void> {
    queue = createDeliveryQueue(producerRedisUrl);
    await queue.queue.waitUntilReady();
    worker = createDeliveryWorker(database.db, redisUrl);
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

  async function createEndpoint(): Promise<string> {
    const response = await app?.inject({
      method: "POST",
      url: "/endpoints",
      payload: {
        name: "Task 3 receiver",
        url: receiverUrl,
        signingSecret: "not-used-until-task-4",
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
      await startRuntime(proxy.url);
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

  it("records a non-2xx job as failed without retries or attempt history", async () => {
    receiverStatus = 500;
    await startRuntime();
    const endpointId = await createEndpoint();
    const response = await ingest(endpointId, "task3-http-failure");
    expect(response?.statusCode).toBe(201);
    const deliveryId = response?.json().delivery.id as string;

    const failedJob = await waitFor(
      () => queue!.queue.getJob(deliveryId),
      async (job) => (job ? (await job.getState()) === "failed" : false),
    );
    expect(await failedJob?.getState()).toBe("failed");
    expect(failedJob?.attemptsMade).toBe(1);
    expect(failedJob?.opts.attempts).toBe(1);

    const delivery = await readDelivery(deliveryId);
    expect(delivery?.status).toBe("queued");
    expect(delivery?.deliveredAt).toBeNull();
    expect(delivery?.attemptCount).toBe(0);
    const [attemptCount] = await database.db
      .select({ value: count() })
      .from(deliveryAttempts);
    expect(attemptCount?.value).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(receivedBodies).toHaveLength(1);
  }, 15_000);
});
