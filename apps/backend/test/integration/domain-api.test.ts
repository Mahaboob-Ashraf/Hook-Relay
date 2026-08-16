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
import { deliveries, events } from "../../src/db/schema.js";

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
});
