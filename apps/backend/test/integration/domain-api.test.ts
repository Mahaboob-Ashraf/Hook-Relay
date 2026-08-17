import { resolve } from "node:path";
import { count, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { FastifyInstance } from "fastify";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/api/app.js";
import {
  createDatabase,
  type DatabaseResources,
} from "../../src/db/client.js";
import {
  deliveries,
  deliveryAttempts,
  events,
  webhookEndpoints,
} from "../../src/db/schema.js";

const adminDatabaseUrl =
  process.env.HOOKRELAY_TEST_ADMIN_DATABASE_URL ??
  "postgresql://hookrelay:hookrelay@127.0.0.1:5432/postgres";
const testDatabaseName = "hookrelay_test";

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

describe("Task 2 domain API with PostgreSQL", () => {
  let database: DatabaseResources;
  let app: FastifyInstance;

  beforeAll(async () => {
    await ensureTestDatabase();
    database = createDatabase(databaseUrlFor(testDatabaseName));
    await migrate(database.db, {
      migrationsFolder: resolve(process.cwd(), "drizzle"),
    });
    app = buildApp({
      database: database.db,
      dependencyChecks: {
        postgres: async () => undefined,
        redis: async () => undefined,
      },
    });
  });

  beforeEach(async () => {
    await database.client.unsafe(
      "truncate table delivery_attempts, deliveries, events, webhook_endpoints cascade",
    );
  });

  afterAll(async () => {
    await app?.close();
    await database?.client.end({ timeout: 5 });
  });

  async function createEndpoint(
    overrides: Partial<{ name: string; url: string; signingSecret: string }> = {},
  ) {
    const response = await app.inject({
      method: "POST",
      url: "/endpoints",
      payload: {
        name: "Integration receiver",
        url: "http://localhost:3300/webhook",
        signingSecret: "integration-secret",
        ...overrides,
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ endpoint: { id: string } }>().endpoint;
  }

  function ingest(
    endpointId: string,
    idempotencyKey: string | undefined,
    overrides: Partial<{ eventType: string; payload: unknown }> = {},
  ) {
    return app.inject({
      method: "POST",
      url: "/events",
      ...(idempotencyKey
        ? { headers: { "idempotency-key": idempotencyKey } }
        : {}),
      payload: {
        endpointId,
        eventType: "order.created",
        payload: { orderId: 123 },
        ...overrides,
      },
    });
  }

  async function createDeliveryReadFixture() {
    const endpointId = "00000000-0000-4000-8000-000000000811";
    const otherEndpointId = "00000000-0000-4000-8000-000000000812";
    const eventId = "00000000-0000-4000-8000-000000000821";
    const otherEventId = "00000000-0000-4000-8000-000000000822";
    const deliveryIds = {
      source: "00000000-0000-4000-8000-000000000801",
      replay: "00000000-0000-4000-8000-000000000802",
      branch: "00000000-0000-4000-8000-000000000803",
      child: "00000000-0000-4000-8000-000000000804",
      otherEvent: "00000000-0000-4000-8000-000000000805",
      otherEndpoint: "00000000-0000-4000-8000-000000000806",
    };

    await database.db.insert(webhookEndpoints).values([
      {
        id: endpointId,
        name: "Warehouse relay",
        url: "https://warehouse.example.test/webhook",
        signingSecret: "task8-signing-secret-never-expose",
      },
      {
        id: otherEndpointId,
        name: "Billing relay",
        url: "https://billing.example.test/webhook",
        signingSecret: "task8-other-signing-secret-never-expose",
      },
    ]);
    await database.db.insert(events).values([
      {
        id: eventId,
        eventType: "order.created",
        payload: {
          orderId: 314,
          lineItems: [{ sku: "HOOK-8", quantity: 2 }],
        },
        idempotencyKey: "task8-ingestion-key-never-expose",
        createdAt: new Date("2026-02-01T09:00:00.000Z"),
      },
      {
        id: otherEventId,
        eventType: "inventory.adjusted",
        payload: { sku: "HOOK-8", delta: -2 },
        idempotencyKey: "task8-other-ingestion-key-never-expose",
        createdAt: new Date("2026-02-01T09:01:00.000Z"),
      },
    ]);

    await database.db.insert(deliveries).values({
      id: deliveryIds.source,
      eventId,
      endpointId,
      status: "dead_letter",
      attemptCount: 5,
      createdAt: new Date("2026-02-01T10:00:00.000Z"),
    });
    await database.db.insert(deliveries).values([
      {
        id: deliveryIds.replay,
        eventId,
        endpointId,
        status: "dead_letter",
        attemptCount: 3,
        replayedFromDeliveryId: deliveryIds.source,
        replayIdempotencyKey: "task8-replay-key-never-expose",
        createdAt: new Date("2026-02-03T10:00:00.000Z"),
      },
      {
        id: deliveryIds.branch,
        eventId,
        endpointId,
        status: "delivered",
        attemptCount: 1,
        deliveredAt: new Date("2026-02-03T10:10:00.000Z"),
        replayedFromDeliveryId: deliveryIds.source,
        replayIdempotencyKey: "task8-branch-key-never-expose",
        createdAt: new Date("2026-02-03T10:00:00.000Z"),
      },
      {
        id: deliveryIds.otherEvent,
        eventId: otherEventId,
        endpointId,
        status: "delivering",
        attemptCount: 1,
        createdAt: new Date("2026-02-05T10:00:00.000Z"),
      },
      {
        id: deliveryIds.otherEndpoint,
        eventId,
        endpointId: otherEndpointId,
        status: "delivered",
        attemptCount: 1,
        deliveredAt: new Date("2026-02-06T10:01:00.000Z"),
        createdAt: new Date("2026-02-06T10:00:00.000Z"),
      },
    ]);
    await database.db.insert(deliveries).values({
      id: deliveryIds.child,
      eventId,
      endpointId,
      status: "queued",
      replayedFromDeliveryId: deliveryIds.replay,
      replayIdempotencyKey: "task8-child-key-never-expose",
      createdAt: new Date("2026-02-04T10:00:00.000Z"),
    });

    await database.db.insert(deliveryAttempts).values([
      {
        deliveryId: deliveryIds.replay,
        attemptNumber: 3,
        startedAt: new Date("2026-02-03T10:03:00.000Z"),
        completedAt: new Date("2026-02-03T10:03:00.025Z"),
        responseStatus: 400,
        latencyMs: 25,
        errorMessage: "HTTP 400",
      },
      {
        deliveryId: deliveryIds.replay,
        attemptNumber: 1,
        startedAt: new Date("2026-02-03T10:01:00.000Z"),
        completedAt: new Date("2026-02-03T10:01:00.018Z"),
        responseStatus: 500,
        latencyMs: 18,
        errorMessage: "HTTP 500",
      },
      {
        deliveryId: deliveryIds.replay,
        attemptNumber: 2,
        startedAt: new Date("2026-02-03T10:02:00.000Z"),
      },
    ]);

    return { endpointId, eventId, deliveryIds };
  }

  it("creates and lists endpoints without exposing signing secrets", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/endpoints",
      payload: {
        name: "Local demo receiver",
        url: "http://localhost:3300/demo/webhook",
        signingSecret: "some-secret",
      },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      endpoint: {
        name: "Local demo receiver",
        url: "http://localhost:3300/demo/webhook",
      },
    });
    expect(created.body).not.toContain("some-secret");
    expect(created.json().endpoint).not.toHaveProperty("signingSecret");

    const listed = await app.inject({ method: "GET", url: "/endpoints" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().endpoints).toHaveLength(1);
    expect(listed.json().endpoints[0].id).toBe(created.json().endpoint.id);
    expect(listed.body).not.toContain("some-secret");
  });

  it("rejects an endpoint URL that is not HTTP or HTTPS", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/endpoints",
      payload: {
        name: "Invalid receiver",
        url: "ftp://localhost/webhook",
        signingSecret: "some-secret",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("validation_error");
  });

  it("atomically creates an event and its queued initial delivery", async () => {
    const endpoint = await createEndpoint();
    const response = await ingest(endpoint.id, "first-ingestion");

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      event: { eventType: "order.created" },
      delivery: { status: "queued", attemptCount: 0 },
      reused: false,
    });

    const [eventCount] = await database.db.select({ value: count() }).from(events);
    const [deliveryCount] = await database.db.select({ value: count() }).from(deliveries);
    expect(eventCount?.value).toBe(1);
    expect(deliveryCount?.value).toBe(1);
  });

  it("returns the same event and delivery for an equivalent duplicate payload", async () => {
    const endpoint = await createEndpoint();
    const first = await ingest(endpoint.id, "exact-duplicate", {
      payload: { orderId: 123, metadata: { b: 2, a: 1 } },
    });
    const duplicate = await ingest(endpoint.id, "exact-duplicate", {
      payload: { metadata: { a: 1, b: 2 }, orderId: 123 },
    });

    expect(first.statusCode).toBe(201);
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().reused).toBe(true);
    expect(duplicate.json().event.id).toBe(first.json().event.id);
    expect(duplicate.json().delivery.id).toBe(first.json().delivery.id);

    const [eventCount] = await database.db.select({ value: count() }).from(events);
    const [deliveryCount] = await database.db.select({ value: count() }).from(deliveries);
    expect(eventCount?.value).toBe(1);
    expect(deliveryCount?.value).toBe(1);
  });

  it("returns 409 when the same key is reused with a changed payload", async () => {
    const endpoint = await createEndpoint();
    await ingest(endpoint.id, "changed-payload");
    const response = await ingest(endpoint.id, "changed-payload", {
      payload: { orderId: 999 },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("idempotency_conflict");
  });

  it("returns 409 when the same key is reused with a changed event type", async () => {
    const endpoint = await createEndpoint();
    await ingest(endpoint.id, "changed-type");
    const response = await ingest(endpoint.id, "changed-type", {
      eventType: "order.cancelled",
    });

    expect(response.statusCode).toBe(409);
  });

  it("returns 409 when the same key is reused with a changed endpoint", async () => {
    const firstEndpoint = await createEndpoint({ name: "First" });
    const secondEndpoint = await createEndpoint({ name: "Second" });
    await ingest(firstEndpoint.id, "changed-endpoint");
    const response = await ingest(secondEndpoint.id, "changed-endpoint");

    expect(response.statusCode).toBe(409);
  });

  it("returns 404 for an unknown endpoint", async () => {
    const response = await ingest(
      "00000000-0000-4000-8000-000000000000",
      "unknown-endpoint",
    );
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("endpoint_not_found");
  });

  it("returns 400 when the idempotency key is missing", async () => {
    const endpoint = await createEndpoint();
    const response = await ingest(endpoint.id, undefined);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("validation_error");
  });

  it("returns 400 for malformed JSON without exposing parser errors", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/events",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "malformed-json",
      },
      payload: '{"endpointId":',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: "validation_error",
        message: "Invalid request body.",
      },
    });
  });

  it("uses the unique constraint to resolve concurrent duplicate requests", async () => {
    const endpoint = await createEndpoint();
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        ingest(endpoint.id, "concurrent-duplicate", {
          payload: { orderId: 123, nested: { value: true } },
        }),
      ),
    );

    expect(responses.filter((response) => response.statusCode === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(7);
    const eventIds = new Set(responses.map((response) => response.json().event.id));
    const deliveryIds = new Set(responses.map((response) => response.json().delivery.id));
    expect(eventIds.size).toBe(1);
    expect(deliveryIds.size).toBe(1);

    const [eventCount] = await database.db.select({ value: count() }).from(events);
    const [deliveryCount] = await database.db.select({ value: count() }).from(deliveries);
    expect(eventCount?.value).toBe(1);
    expect(deliveryCount?.value).toBe(1);
  });

  it("rolls back the event when initial delivery creation fails", async () => {
    const endpoint = await createEndpoint();
    await database.client.unsafe(`
      create function hookrelay_test_reject_delivery() returns trigger as $$
      begin
        raise exception 'forced delivery failure';
      end;
      $$ language plpgsql
    `);
    await database.client.unsafe(`
      create trigger hookrelay_test_reject_delivery_trigger
      before insert on deliveries
      for each row execute function hookrelay_test_reject_delivery()
    `);

    try {
      const response = await ingest(endpoint.id, "atomicity-failure");
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        error: {
          code: "internal_error",
          message: "An internal error occurred.",
        },
      });

      const [event] = await database.db
        .select({ id: events.id })
        .from(events)
        .where(eq(events.idempotencyKey, "atomicity-failure"));
      expect(event).toBeUndefined();
    } finally {
      await database.client.unsafe(
        "drop trigger if exists hookrelay_test_reject_delivery_trigger on deliveries",
      );
      await database.client.unsafe(
        "drop function if exists hookrelay_test_reject_delivery()",
      );
    }
  });

  it("lists deliveries newest-first with deterministic pagination and a total", async () => {
    const { deliveryIds } = await createDeliveryReadFixture();

    const response = await app.inject({ method: "GET", url: "/deliveries" });
    expect(response.statusCode).toBe(200);
    expect(response.json().page).toEqual({ limit: 50, offset: 0, total: 6 });
    expect(response.json().deliveries.map((delivery: { id: string }) => delivery.id)).toEqual([
      deliveryIds.otherEndpoint,
      deliveryIds.otherEvent,
      deliveryIds.child,
      deliveryIds.branch,
      deliveryIds.replay,
      deliveryIds.source,
    ]);

    const page = await app.inject({
      method: "GET",
      url: "/deliveries?limit=2&offset=3",
    });
    expect(page.statusCode).toBe(200);
    expect(page.json().page).toEqual({ limit: 2, offset: 3, total: 6 });
    expect(page.json().deliveries.map((delivery: { id: string }) => delivery.id)).toEqual([
      deliveryIds.branch,
      deliveryIds.replay,
    ]);
  });

  it("filters delivery status before counting and paginating", async () => {
    const { deliveryIds } = await createDeliveryReadFixture();

    const first = await app.inject({
      method: "GET",
      url: "/deliveries?status=delivered&limit=1",
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      deliveries: [{ id: deliveryIds.otherEndpoint, status: "delivered" }],
      page: { limit: 1, offset: 0, total: 2 },
    });

    const second = await app.inject({
      method: "GET",
      url: "/deliveries?status=delivered&limit=1&offset=1",
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      deliveries: [{ id: deliveryIds.branch, status: "delivered" }],
      page: { limit: 1, offset: 1, total: 2 },
    });
  });

  it("validates delivery list filters and pagination bounds", async () => {
    for (const query of [
      "status=unknown",
      "limit=0",
      "limit=101",
      "limit=1.5",
      "limit=not-a-number",
      "offset=-1",
      "offset=1.5",
      "offset=not-a-number",
      "unexpected=value",
    ]) {
      const response = await app.inject({
        method: "GET",
        url: `/deliveries?${query}`,
      });
      expect(response.statusCode, query).toBe(400);
      expect(response.json(), query).toMatchObject({
        error: { code: "validation_error" },
      });
    }

    const maximum = await app.inject({
      method: "GET",
      url: "/deliveries?limit=100&offset=0",
    });
    expect(maximum.statusCode).toBe(200);
    expect(maximum.json().page).toEqual({ limit: 100, offset: 0, total: 0 });
  });

  it("returns explicit joined delivery fields without exposing secrets or keys", async () => {
    const { endpointId, eventId, deliveryIds } = await createDeliveryReadFixture();

    const response = await app.inject({
      method: "GET",
      url: "/deliveries?status=dead_letter",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().deliveries[0]).toEqual({
      id: deliveryIds.replay,
      status: "dead_letter",
      attemptCount: 3,
      nextAttemptAt: null,
      deliveredAt: null,
      replayedFromDeliveryId: deliveryIds.source,
      createdAt: "2026-02-03T10:00:00.000Z",
      event: {
        id: eventId,
        eventType: "order.created",
        createdAt: "2026-02-01T09:00:00.000Z",
      },
      endpoint: {
        id: endpointId,
        name: "Warehouse relay",
        url: "https://warehouse.example.test/webhook",
      },
    });

    for (const forbidden of [
      "task8-signing-secret-never-expose",
      "task8-ingestion-key-never-expose",
      "task8-replay-key-never-expose",
      "signingSecret",
      "idempotencyKey",
      "replayIdempotencyKey",
    ]) {
      expect(response.body).not.toContain(forbidden);
    }
  });

  it("returns ordered durable attempts and the branching replay graph", async () => {
    const { endpointId, eventId, deliveryIds } = await createDeliveryReadFixture();

    const response = await app.inject({
      method: "GET",
      url: `/deliveries/${deliveryIds.replay}`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.delivery).toEqual({
      id: deliveryIds.replay,
      status: "dead_letter",
      attemptCount: 3,
      nextAttemptAt: null,
      deliveredAt: null,
      replayedFromDeliveryId: deliveryIds.source,
      createdAt: "2026-02-03T10:00:00.000Z",
      event: {
        id: eventId,
        eventType: "order.created",
        payload: {
          orderId: 314,
          lineItems: [{ sku: "HOOK-8", quantity: 2 }],
        },
        createdAt: "2026-02-01T09:00:00.000Z",
      },
      endpoint: {
        id: endpointId,
        name: "Warehouse relay",
        url: "https://warehouse.example.test/webhook",
      },
    });
    expect(body.attempts.map((attempt: { attemptNumber: number }) => attempt.attemptNumber)).toEqual([
      1,
      2,
      3,
    ]);
    expect(body.attempts[0]).toMatchObject({
      attemptNumber: 1,
      completedAt: "2026-02-03T10:01:00.018Z",
      responseStatus: 500,
      latencyMs: 18,
      errorMessage: "HTTP 500",
    });
    expect(body.attempts[1]).toMatchObject({
      attemptNumber: 2,
      startedAt: "2026-02-03T10:02:00.000Z",
      completedAt: null,
      responseStatus: null,
      latencyMs: null,
      errorMessage: null,
    });
    expect(body.attempts[2]).toMatchObject({
      attemptNumber: 3,
      responseStatus: 400,
      errorMessage: "HTTP 400",
    });
    expect(body.relatedDeliveries).toEqual([
      {
        id: deliveryIds.source,
        status: "dead_letter",
        createdAt: "2026-02-01T10:00:00.000Z",
        replayedFromDeliveryId: null,
      },
      {
        id: deliveryIds.replay,
        status: "dead_letter",
        createdAt: "2026-02-03T10:00:00.000Z",
        replayedFromDeliveryId: deliveryIds.source,
      },
      {
        id: deliveryIds.branch,
        status: "delivered",
        createdAt: "2026-02-03T10:00:00.000Z",
        replayedFromDeliveryId: deliveryIds.source,
      },
      {
        id: deliveryIds.child,
        status: "queued",
        createdAt: "2026-02-04T10:00:00.000Z",
        replayedFromDeliveryId: deliveryIds.replay,
      },
    ]);

    for (const forbidden of [
      "task8-signing-secret-never-expose",
      "task8-ingestion-key-never-expose",
      "task8-replay-key-never-expose",
      "task8-branch-key-never-expose",
      "task8-child-key-never-expose",
      "signingSecret",
      "idempotencyKey",
      "replayIdempotencyKey",
    ]) {
      expect(response.body).not.toContain(forbidden);
    }
  });

  it("returns validation and not-found errors for delivery detail lookup", async () => {
    const invalid = await app.inject({
      method: "GET",
      url: "/deliveries/not-a-uuid",
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({
      error: { code: "validation_error" },
    });

    const missing = await app.inject({
      method: "GET",
      url: "/deliveries/00000000-0000-4000-8000-000000000899",
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({
      error: {
        code: "delivery_not_found",
        message: "Delivery was not found.",
      },
    });
  });
});
