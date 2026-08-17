import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres, { type Sql } from "postgres";
import { buildApp } from "../api/app.js";
import { createDatabase, type DatabaseResources } from "../db/client.js";
import { checkDatabase } from "../db/health.js";
import { deliveries, events, webhookEndpoints } from "../db/schema.js";
import { createDemoReceiver } from "../demo-receiver/app.js";
import {
  createDeliveryQueue,
  type DeliveryQueueResources,
} from "../queue/delivery-queue.js";
import {
  checkRedis,
  closeRedis,
  createRedisClient,
  type RedisClient,
} from "../redis/client.js";
import { PRODUCTION_RETRY_POLICY } from "../retry/delivery-retry-policy.js";
import {
  createDeliveryWorker,
  type DeliveryWorkerResources,
} from "../worker/delivery-worker.js";

const PERCENTILE_METHOD =
  "Nearest-rank: sort ascending and select value at ceil(percentile * sampleCount), using one-based rank.";
const RESULT_LABEL = "Local development benchmark — not a production capacity claim";
const IDEMPOTENCY_CONCURRENCY = 25;
const REPLAY_CONCURRENCY = 25;
const CLOCK_SAMPLE_DRIFT_LIMIT_MS = 250;
const CLOCK_STABLE_SAMPLES = 10;
const repositoryRoot = resolve(
  fileURLToPath(new URL("../../../../", import.meta.url)),
);

type BenchmarkConfiguration = {
  warmupEvents: number;
  measuredEventsPerRun: number;
  ingestionConcurrency: number;
  measuredRuns: number;
  timeoutMs: number;
  adminDatabaseUrl: string;
  benchmarkDatabaseName: string;
  redisUrl: string;
};

type SampleStatistics = {
  sampleCount: number;
  average: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
};

type BatchState = {
  event_count: number;
  delivery_count: number;
  delivered_count: number;
  dead_letter_count: number;
  attempt_count: number;
  first_attempt_count: number;
};

type MeasuredRun = {
  runNumber: number;
  eventType: string;
  configuredEventCount: number;
  acceptedEventCount: number;
  deliveredEventCount: number;
  failedOrNonDeliveredCount: number;
  terminalSuccessRate: number;
  ingestionDurationMs: number;
  totalDurationMs: number;
  ingestionThroughputEventsPerSecond: number;
  deliveryThroughputDeliveriesPerSecond: number;
  clientObservedIngestionLatencyMs: SampleStatistics;
  persistedEndToEndDeliveryLatencyMs: SampleStatistics;
  databaseVerification: {
    eventCount: number;
    initialDeliveryCount: number;
    attemptCount: number;
    firstAttemptCount: number;
  };
};

type Runtime = {
  database: DatabaseResources;
  apiBaseUrl: string;
  endpointId: string;
  timeoutMs: number;
  runId: string;
};

function parseInteger(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function loadConfiguration(): BenchmarkConfiguration {
  const benchmarkDatabaseName =
    process.env.HOOKRELAY_BENCHMARK_DATABASE_NAME ?? "hookrelay_benchmark";
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(benchmarkDatabaseName)) {
    throw new Error(
      "HOOKRELAY_BENCHMARK_DATABASE_NAME must be a safe lowercase PostgreSQL identifier.",
    );
  }

  return {
    warmupEvents: parseInteger("HOOKRELAY_BENCHMARK_WARMUP_EVENTS", 25, 0, 1_000),
    measuredEventsPerRun: parseInteger(
      "HOOKRELAY_BENCHMARK_EVENTS",
      500,
      1,
      10_000,
    ),
    ingestionConcurrency: parseInteger(
      "HOOKRELAY_BENCHMARK_CONCURRENCY",
      25,
      1,
      200,
    ),
    measuredRuns: parseInteger("HOOKRELAY_BENCHMARK_RUNS", 3, 1, 10),
    timeoutMs: parseInteger(
      "HOOKRELAY_BENCHMARK_TIMEOUT_MS",
      120_000,
      5_000,
      600_000,
    ),
    adminDatabaseUrl:
      process.env.HOOKRELAY_BENCHMARK_ADMIN_DATABASE_URL ??
      "postgresql://hookrelay:hookrelay@127.0.0.1:5432/postgres",
    benchmarkDatabaseName,
    // Redis database 15 isolates the benchmark from the normal development queue.
    redisUrl:
      process.env.HOOKRELAY_BENCHMARK_REDIS_URL ??
      "redis://127.0.0.1:6379/15",
  };
}

function databaseUrlFor(adminDatabaseUrl: string, databaseName: string): string {
  const url = new URL(adminDatabaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function ensureBenchmarkDatabase(
  adminDatabaseUrl: string,
  databaseName: string,
): Promise<void> {
  const admin = postgres(adminDatabaseUrl, { max: 1 });
  try {
    const rows = await admin<{ exists: boolean }[]>`
      select exists(
        select 1 from pg_database where datname = ${databaseName}
      ) as exists
    `;
    if (!rows[0]?.exists) {
      await admin.unsafe(`create database "${databaseName}"`);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
}

function round(value: number, digits = 3): number {
  if (!Number.isFinite(value)) {
    throw new Error("Benchmark produced a non-finite measurement.");
  }
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function nearestRank(samples: readonly number[], percentile: number): number {
  if (samples.length === 0) throw new Error("Cannot calculate a percentile without samples.");
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(percentile * sorted.length) - 1);
  const value = sorted[index];
  if (value === undefined || !Number.isFinite(value)) {
    throw new Error("Benchmark percentile sample was missing or non-finite.");
  }
  return value;
}

function statistics(samples: readonly number[]): SampleStatistics {
  if (
    samples.length === 0 ||
    samples.some((sample) => !Number.isFinite(sample) || sample < 0)
  ) {
    throw new Error("Benchmark statistics require finite, nonnegative, non-empty samples.");
  }
  const total = samples.reduce((sum, sample) => sum + sample, 0);
  return {
    sampleCount: samples.length,
    average: round(total / samples.length),
    p50: round(nearestRank(samples, 0.5)),
    p95: round(nearestRank(samples, 0.95)),
    min: round(Math.min(...samples)),
    max: round(Math.max(...samples)),
  };
}

function distribution(samples: readonly number[]) {
  const average = samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
  const variance =
    samples.reduce((sum, sample) => sum + (sample - average) ** 2, 0) /
    samples.length;
  return {
    mean: round(average),
    median: round(nearestRank(samples, 0.5)),
    min: round(Math.min(...samples)),
    max: round(Math.max(...samples)),
    standardDeviation: round(Math.sqrt(variance)),
  };
}

async function runConcurrently<T>(
  count: number,
  concurrency: number,
  operation: (index: number) => Promise<T>,
): Promise<T[]> {
  const results: Array<T | undefined> = new Array(count);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(count, concurrency) },
    async () => {
      while (nextIndex < count) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await operation(index);
      }
    },
  );
  await Promise.all(workers);
  if (results.some((result) => result === undefined)) {
    throw new Error("A concurrent benchmark operation did not produce a result.");
  }
  return results as T[];
}

async function postJson<T>(
  url: string,
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: T }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
  const body = (await response.json()) as T;
  return { status: response.status, body };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function readBatchState(client: Sql, eventType: string): Promise<BatchState> {
  const rows = await client<BatchState[]>`
    with target_events as (
      select id from events where event_type = ${eventType}
    ),
    target_deliveries as (
      select d.id, d.status
      from deliveries d
      inner join target_events e on e.id = d.event_id
      where d.replayed_from_delivery_id is null
    )
    select
      (select count(*)::integer from target_events) as event_count,
      (select count(*)::integer from target_deliveries) as delivery_count,
      (select count(*)::integer from target_deliveries where status = 'delivered') as delivered_count,
      (select count(*)::integer from target_deliveries where status = 'dead_letter') as dead_letter_count,
      (
        select count(*)::integer
        from delivery_attempts a
        inner join target_deliveries d on d.id = a.delivery_id
      ) as attempt_count,
      (
        select count(*)::integer
        from delivery_attempts a
        inner join target_deliveries d on d.id = a.delivery_id
        where a.attempt_number = 1
      ) as first_attempt_count
  `;
  const row = rows[0];
  if (!row) throw new Error("Benchmark state query returned no row.");
  return row;
}

async function waitForBatch(
  client: Sql,
  eventType: string,
  expectedCount: number,
  timeoutMs: number,
): Promise<BatchState> {
  const deadline = Date.now() + timeoutMs;
  let state = await readBatchState(client, eventType);
  while (state.delivered_count < expectedCount && Date.now() < deadline) {
    if (state.dead_letter_count > 0) break;
    await sleep(50);
    state = await readBatchState(client, eventType);
  }
  if (state.delivered_count !== expectedCount) {
    throw new Error(
      `Expected ${expectedCount} delivered benchmark events but observed ${state.delivered_count} before timeout.`,
    );
  }
  return state;
}

async function waitForDelivery(
  client: Sql,
  deliveryId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await client<{ status: string }[]>`
      select status from deliveries where id = ${deliveryId}
    `;
    const status = rows[0]?.status;
    if (status === "delivered") return;
    if (status === "dead_letter") {
      throw new Error(`Benchmark delivery ${deliveryId} reached dead_letter.`);
    }
    await sleep(50);
  }
  throw new Error(`Timed out waiting for benchmark delivery ${deliveryId}.`);
}

async function waitForDatabaseClockStability(
  client: Sql,
  timeoutMs: number,
): Promise<{
  absoluteOffsetMs: number;
  sampleDriftMs: number;
  consecutiveSamples: number;
}> {
  const deadline = Date.now() + timeoutMs;
  let consecutiveSamples = 0;
  let absoluteOffsetMs = Number.POSITIVE_INFINITY;
  let sampleDriftMs = Number.POSITIVE_INFINITY;
  let previousDatabaseTimeMs: number | undefined;
  let previousClientTimeMs: number | undefined;

  while (Date.now() < deadline) {
    const clientBefore = Date.now();
    const rows = await client<{ database_time_ms: number }[]>`
      select extract(epoch from clock_timestamp())::double precision * 1000 as database_time_ms
    `;
    const clientAfter = Date.now();
    const databaseTimeMs = rows[0]?.database_time_ms;
    if (databaseTimeMs === undefined || !Number.isFinite(databaseTimeMs)) {
      throw new Error("PostgreSQL clock check returned no finite timestamp.");
    }
    const clientTimeMs = (clientBefore + clientAfter) / 2;
    absoluteOffsetMs = databaseTimeMs - clientTimeMs;
    if (
      previousDatabaseTimeMs !== undefined &&
      previousClientTimeMs !== undefined
    ) {
      const databaseDeltaMs = databaseTimeMs - previousDatabaseTimeMs;
      const clientDeltaMs = clientTimeMs - previousClientTimeMs;
      sampleDriftMs = Math.abs(databaseDeltaMs - clientDeltaMs);
      consecutiveSamples =
        databaseDeltaMs >= 0 && sampleDriftMs <= CLOCK_SAMPLE_DRIFT_LIMIT_MS
          ? consecutiveSamples + 1
          : 0;
    }
    previousDatabaseTimeMs = databaseTimeMs;
    previousClientTimeMs = clientTimeMs;
    if (consecutiveSamples >= CLOCK_STABLE_SAMPLES) {
      return {
        absoluteOffsetMs: round(absoluteOffsetMs),
        sampleDriftMs: round(sampleDriftMs),
        consecutiveSamples,
      };
    }
    await sleep(200);
  }

  throw new Error(
    `PostgreSQL clock did not advance consistently with the benchmark client within ${CLOCK_SAMPLE_DRIFT_LIMIT_MS} ms for ${CLOCK_STABLE_SAMPLES} consecutive samples. Last sample drift was ${round(sampleDriftMs)} ms.`,
  );
}

async function readPersistedLatencies(
  client: Sql,
  eventType: string,
): Promise<number[]> {
  const rows = await client<{ latency_ms: number }[]>`
    select extract(epoch from (d.delivered_at - d.created_at))::double precision * 1000 as latency_ms
    from deliveries d
    inner join events e on e.id = d.event_id
    where e.event_type = ${eventType}
      and d.replayed_from_delivery_id is null
      and d.delivered_at is not null
    order by d.id
  `;
  return rows.map((row) => row.latency_ms);
}

async function runBatch(
  runtime: Runtime,
  label: string,
  eventCount: number,
  concurrency: number,
  runNumber: number,
): Promise<MeasuredRun> {
  const eventType = `hookrelay.benchmark.${runtime.runId}.${label}`;
  const batchStartedAt = performance.now();
  const responses = await runConcurrently(eventCount, concurrency, async (index) => {
    const requestStartedAt = performance.now();
    const response = await postJson<{
      event?: { id?: string };
      delivery?: { id?: string };
      reused?: boolean;
      error?: { code?: string };
    }>(
      `${runtime.apiBaseUrl}/events`,
      {
        endpointId: runtime.endpointId,
        eventType,
        payload: { benchmarkRunId: runtime.runId, batch: label, index },
      },
      { "idempotency-key": `${runtime.runId}:${label}:${index}` },
    );
    const latencyMs = performance.now() - requestStartedAt;
    if (
      response.status !== 201 ||
      response.body.reused !== false ||
      !response.body.event?.id ||
      !response.body.delivery?.id
    ) {
      throw new Error(
        `Measured ingestion ${index} failed with HTTP ${response.status} (${response.body.error?.code ?? "unexpected_response"}).`,
      );
    }
    return {
      eventId: response.body.event.id,
      deliveryId: response.body.delivery.id,
      latencyMs,
    };
  });
  const ingestionCompletedAt = performance.now();

  if (new Set(responses.map((response) => response.eventId)).size !== eventCount) {
    throw new Error("Measured ingestion created duplicate logical event identity.");
  }
  if (new Set(responses.map((response) => response.deliveryId)).size !== eventCount) {
    throw new Error("Measured ingestion created duplicate logical delivery identity.");
  }

  const state = await waitForBatch(
    runtime.database.client,
    eventType,
    eventCount,
    runtime.timeoutMs,
  );
  const completedAt = performance.now();
  if (
    state.event_count !== eventCount ||
    state.delivery_count !== eventCount ||
    state.attempt_count !== eventCount ||
    state.first_attempt_count !== eventCount
  ) {
    throw new Error(
      `Benchmark database verification failed for ${label}: ${JSON.stringify(state)}.`,
    );
  }

  const persistedLatencies = await readPersistedLatencies(
    runtime.database.client,
    eventType,
  );
  if (persistedLatencies.length !== eventCount) {
    throw new Error("Persisted end-to-end latency samples were incomplete.");
  }

  const ingestionDurationMs = ingestionCompletedAt - batchStartedAt;
  const totalDurationMs = completedAt - batchStartedAt;
  const terminalCount = state.delivered_count + state.dead_letter_count;
  if (terminalCount !== eventCount) {
    throw new Error("Benchmark success-rate denominator did not include every measured event.");
  }

  return {
    runNumber,
    eventType,
    configuredEventCount: eventCount,
    acceptedEventCount: responses.length,
    deliveredEventCount: state.delivered_count,
    failedOrNonDeliveredCount: eventCount - state.delivered_count,
    terminalSuccessRate: round(state.delivered_count / terminalCount, 6),
    ingestionDurationMs: round(ingestionDurationMs),
    totalDurationMs: round(totalDurationMs),
    ingestionThroughputEventsPerSecond: round(
      responses.length / (ingestionDurationMs / 1_000),
    ),
    deliveryThroughputDeliveriesPerSecond: round(
      state.delivered_count / (totalDurationMs / 1_000),
    ),
    clientObservedIngestionLatencyMs: statistics(
      responses.map((response) => response.latencyMs),
    ),
    persistedEndToEndDeliveryLatencyMs: statistics(persistedLatencies),
    databaseVerification: {
      eventCount: state.event_count,
      initialDeliveryCount: state.delivery_count,
      attemptCount: state.attempt_count,
      firstAttemptCount: state.first_attempt_count,
    },
  };
}

async function verifyIngestionConcurrency(runtime: Runtime) {
  const eventType = `hookrelay.benchmark.${runtime.runId}.idempotency`;
  const idempotencyKey = `${runtime.runId}:concurrent-ingestion`;
  const responses = await Promise.all(
    Array.from({ length: IDEMPOTENCY_CONCURRENCY }, () =>
      postJson<{
        event?: { id?: string };
        delivery?: { id?: string };
        error?: { code?: string };
      }>(
        `${runtime.apiBaseUrl}/events`,
        {
          endpointId: runtime.endpointId,
          eventType,
          payload: { benchmarkRunId: runtime.runId, check: "ingestion-idempotency" },
        },
        { "idempotency-key": idempotencyKey },
      ),
    ),
  );
  for (const response of responses) {
    if (
      ![200, 201].includes(response.status) ||
      !response.body.event?.id ||
      !response.body.delivery?.id
    ) {
      throw new Error(
        `Concurrent idempotent ingestion failed with HTTP ${response.status} (${response.body.error?.code ?? "unexpected_response"}).`,
      );
    }
  }
  const eventIds = new Set(responses.map((response) => response.body.event?.id));
  const deliveryIds = new Set(
    responses.map((response) => response.body.delivery?.id),
  );
  const deliveryId = responses[0]?.body.delivery?.id;
  if (!deliveryId) throw new Error("Concurrent ingestion returned no delivery identity.");
  await waitForDelivery(runtime.database.client, deliveryId, runtime.timeoutMs);

  const rows = await runtime.database.client<{
    event_count: number;
    delivery_count: number;
  }[]>`
    select
      (select count(*)::integer from events where idempotency_key = ${idempotencyKey}) as event_count,
      (
        select count(*)::integer
        from deliveries d
        inner join events e on e.id = d.event_id
        where e.idempotency_key = ${idempotencyKey}
          and d.replayed_from_delivery_id is null
      ) as delivery_count
  `;
  const databaseVerification = rows[0];
  if (
    eventIds.size !== 1 ||
    deliveryIds.size !== 1 ||
    databaseVerification?.event_count !== 1 ||
    databaseVerification.delivery_count !== 1
  ) {
    throw new Error("Concurrent ingestion idempotency verification failed.");
  }

  return {
    concurrency: IDEMPOTENCY_CONCURRENCY,
    responseCount: responses.length,
    uniqueEventIds: eventIds.size,
    uniqueDeliveryIds: deliveryIds.size,
    postgresql: {
      eventRows: databaseVerification.event_count,
      initialDeliveryRows: databaseVerification.delivery_count,
    },
  };
}

async function verifyReplayConcurrency(runtime: Runtime) {
  const [event] = await runtime.database.db
    .insert(events)
    .values({
      eventType: `hookrelay.benchmark.${runtime.runId}.replay-source`,
      payload: { benchmarkRunId: runtime.runId, check: "replay-idempotency" },
      idempotencyKey: `${runtime.runId}:replay-source`,
    })
    .returning({ id: events.id });
  if (!event) throw new Error("Failed to create replay concurrency source event.");
  const [source] = await runtime.database.db
    .insert(deliveries)
    .values({
      eventId: event.id,
      endpointId: runtime.endpointId,
      status: "dead_letter",
    })
    .returning({
      id: deliveries.id,
      eventId: deliveries.eventId,
      endpointId: deliveries.endpointId,
      status: deliveries.status,
      attemptCount: deliveries.attemptCount,
      nextAttemptAt: deliveries.nextAttemptAt,
      deliveredAt: deliveries.deliveredAt,
      replayedFromDeliveryId: deliveries.replayedFromDeliveryId,
      createdAt: deliveries.createdAt,
    });
  if (!source) throw new Error("Failed to create replay concurrency source delivery.");

  const idempotencyKey = `${runtime.runId}:concurrent-replay`;
  const responses = await Promise.all(
    Array.from({ length: REPLAY_CONCURRENCY }, () =>
      postJson<{
        replayDelivery?: { id?: string };
        error?: { code?: string };
      }>(
        `${runtime.apiBaseUrl}/deliveries/${source.id}/replay`,
        {},
        { "idempotency-key": idempotencyKey },
      ),
    ),
  );
  for (const response of responses) {
    if (
      ![200, 201].includes(response.status) ||
      !response.body.replayDelivery?.id
    ) {
      throw new Error(
        `Concurrent replay failed with HTTP ${response.status} (${response.body.error?.code ?? "unexpected_response"}).`,
      );
    }
  }
  const replayIds = new Set(
    responses.map((response) => response.body.replayDelivery?.id),
  );
  const replayId = responses[0]?.body.replayDelivery?.id;
  if (!replayId) throw new Error("Concurrent replay returned no delivery identity.");
  await waitForDelivery(runtime.database.client, replayId, runtime.timeoutMs);

  const replayCountRows = await runtime.database.client<{ value: number }[]>`
    select count(*)::integer as value
    from deliveries
    where replayed_from_delivery_id = ${source.id}
      and replay_idempotency_key = ${idempotencyKey}
  `;
  const [sourceAfter] = await runtime.database.db
    .select({
      id: deliveries.id,
      eventId: deliveries.eventId,
      endpointId: deliveries.endpointId,
      status: deliveries.status,
      attemptCount: deliveries.attemptCount,
      nextAttemptAt: deliveries.nextAttemptAt,
      deliveredAt: deliveries.deliveredAt,
      replayedFromDeliveryId: deliveries.replayedFromDeliveryId,
      createdAt: deliveries.createdAt,
    })
    .from(deliveries)
    .where(eq(deliveries.id, source.id));
  const replayRows = replayCountRows[0]?.value;
  const sourceUnchanged = JSON.stringify(sourceAfter) === JSON.stringify(source);
  if (replayIds.size !== 1 || replayRows !== 1 || !sourceUnchanged) {
    throw new Error("Concurrent replay idempotency verification failed.");
  }

  return {
    concurrency: REPLAY_CONCURRENCY,
    responseCount: responses.length,
    uniqueReplayDeliveryIds: replayIds.size,
    postgresql: {
      replayDeliveryRows: replayRows,
      sourceStatus: sourceAfter?.status,
      sourceUnchanged,
    },
  };
}

function gitOutput(arguments_: string[]): string {
  try {
    return execFileSync("git", arguments_, {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unavailable";
  }
}

function summarizeRuns(runs: readonly MeasuredRun[]) {
  return {
    ingestionThroughputEventsPerSecond: distribution(
      runs.map((run) => run.ingestionThroughputEventsPerSecond),
    ),
    deliveryThroughputDeliveriesPerSecond: distribution(
      runs.map((run) => run.deliveryThroughputDeliveriesPerSecond),
    ),
    clientObservedIngestionLatencyAverageMs: distribution(
      runs.map((run) => run.clientObservedIngestionLatencyMs.average),
    ),
    clientObservedIngestionLatencyP50Ms: distribution(
      runs.map((run) => run.clientObservedIngestionLatencyMs.p50),
    ),
    clientObservedIngestionLatencyP95Ms: distribution(
      runs.map((run) => run.clientObservedIngestionLatencyMs.p95),
    ),
    persistedEndToEndLatencyAverageMs: distribution(
      runs.map((run) => run.persistedEndToEndDeliveryLatencyMs.average),
    ),
    persistedEndToEndLatencyP50Ms: distribution(
      runs.map((run) => run.persistedEndToEndDeliveryLatencyMs.p50),
    ),
    persistedEndToEndLatencyP95Ms: distribution(
      runs.map((run) => run.persistedEndToEndDeliveryLatencyMs.p95),
    ),
    totalDurationMs: distribution(runs.map((run) => run.totalDurationMs)),
  };
}

async function main(): Promise<void> {
  const configuration = loadConfiguration();
  const runId = `task9-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  await ensureBenchmarkDatabase(
    configuration.adminDatabaseUrl,
    configuration.benchmarkDatabaseName,
  );
  const database = createDatabase(
    databaseUrlFor(
      configuration.adminDatabaseUrl,
      configuration.benchmarkDatabaseName,
    ),
  );
  let redis: RedisClient | undefined;
  let queue: DeliveryQueueResources | undefined;
  let worker: DeliveryWorkerResources | undefined;
  const receiver = createDemoReceiver({
    secret: "task9-local-benchmark-secret",
    maxAgeSeconds: 300,
  });
  let api: ReturnType<typeof buildApp> | undefined;

  try {
    await migrate(database.db, {
      migrationsFolder: resolve(repositoryRoot, "apps/backend/drizzle"),
    });
    await checkDatabase(database);
    redis = createRedisClient(configuration.redisUrl);
    await checkRedis(redis);
    queue = createDeliveryQueue(configuration.redisUrl);
    await queue.queue.waitUntilReady();
    worker = createDeliveryWorker(database.db, configuration.redisUrl);
    await worker.worker.waitUntilReady();
    const receiverBaseUrl = await receiver.app.listen({
      port: 0,
      host: "127.0.0.1",
    });
    api = buildApp({
      database: database.db,
      deliveryScheduler: queue,
      dependencyChecks: {
        postgres: () => checkDatabase(database),
        redis: () => checkRedis(redis as RedisClient),
      },
    });
    const apiBaseUrl = await api.listen({ port: 0, host: "127.0.0.1" });

    const readiness = await fetch(`${apiBaseUrl}/health/ready`);
    if (!readiness.ok) throw new Error("Benchmark API did not become dependency-ready.");
    const endpointResponse = await postJson<{
      endpoint?: { id?: string };
      error?: { code?: string };
    }>(`${apiBaseUrl}/endpoints`, {
      name: `Task 9 local benchmark ${runId}`,
      url: `${receiverBaseUrl}/demo/webhook?scenario=${encodeURIComponent(runId)}&fail_first=0`,
      signingSecret: "task9-local-benchmark-secret",
    });
    if (endpointResponse.status !== 201 || !endpointResponse.body.endpoint?.id) {
      throw new Error(
        `Benchmark endpoint creation failed with HTTP ${endpointResponse.status} (${endpointResponse.body.error?.code ?? "unexpected_response"}).`,
      );
    }

    const runtime: Runtime = {
      database,
      apiBaseUrl,
      endpointId: endpointResponse.body.endpoint.id,
      timeoutMs: configuration.timeoutMs,
      runId,
    };
    const clockStabilityChecks: Array<{
      checkpoint: string;
      absoluteOffsetMs: number;
      sampleDriftMs: number;
      consecutiveSamples: number;
    }> = [];
    clockStabilityChecks.push({
      checkpoint: "before-warmup",
      ...(await waitForDatabaseClockStability(
        database.client,
        configuration.timeoutMs,
      )),
    });
    const warmup =
      configuration.warmupEvents === 0
        ? null
        : await runBatch(
            runtime,
            "warmup",
            configuration.warmupEvents,
            configuration.ingestionConcurrency,
            0,
          );
    const measuredRuns: MeasuredRun[] = [];
    for (let runNumber = 1; runNumber <= configuration.measuredRuns; runNumber += 1) {
      clockStabilityChecks.push({
        checkpoint: `before-measured-${runNumber}`,
        ...(await waitForDatabaseClockStability(
          database.client,
          configuration.timeoutMs,
        )),
      });
      measuredRuns.push(
        await runBatch(
          runtime,
          `measured-${runNumber}`,
          configuration.measuredEventsPerRun,
          configuration.ingestionConcurrency,
          runNumber,
        ),
      );
    }

    const ingestionConcurrency = await verifyIngestionConcurrency(runtime);
    const replayConcurrency = await verifyReplayConcurrency(runtime);
    const postgresVersionRows = await database.client<{ server_version: string }[]>`
      show server_version
    `;
    const redisInfo = await redis.info("server");
    const redisVersion = /^redis_version:([^\r\n]+)/m.exec(redisInfo)?.[1] ?? "unknown";
    const commitHash =
      process.env.HOOKRELAY_BENCHMARK_COMMIT_HASH ??
      gitOutput(["rev-parse", "HEAD"]);
    const dirtyWorkingTree =
      process.env.HOOKRELAY_BENCHMARK_DIRTY_WORKTREE === undefined
        ? gitOutput(["status", "--porcelain"]) !== ""
        : process.env.HOOKRELAY_BENCHMARK_DIRTY_WORKTREE === "true";
    const cpu = os.cpus()[0];
    const generatedAt = new Date().toISOString();
    const artifact = {
      label: RESULT_LABEL,
      generatedAt,
      runId,
      metadata: {
        commitHash,
        dirtyWorkingTree,
        nodeVersion: process.version,
        operatingSystem: {
          platform: os.platform(),
          release: os.release(),
          architecture: os.arch(),
        },
        cpu: {
          model: cpu?.model ?? "unknown",
          logicalCpuCount: os.cpus().length,
        },
        totalMemoryBytes: os.totalmem(),
        postgresVersion: postgresVersionRows[0]?.server_version ?? "unknown",
        redisVersion,
        retryPolicy: {
          maxAttempts: PRODUCTION_RETRY_POLICY.maxAttempts,
          retryDelaysMs: PRODUCTION_RETRY_POLICY.retryDelaysMs,
        },
      },
      configuration: {
        warmupEvents: configuration.warmupEvents,
        measuredEventsPerRun: configuration.measuredEventsPerRun,
        ingestionConcurrency: configuration.ingestionConcurrency,
        measuredRuns: configuration.measuredRuns,
        ingestionIdempotencyConcurrency: IDEMPOTENCY_CONCURRENCY,
        replayIdempotencyConcurrency: REPLAY_CONCURRENCY,
        timeoutMs: configuration.timeoutMs,
        clockStabilityGate: {
          maximumSampleDriftMs: CLOCK_SAMPLE_DRIFT_LIMIT_MS,
          requiredConsecutiveSamples: CLOCK_STABLE_SAMPLES,
          checks: clockStabilityChecks,
        },
        percentileMethod: PERCENTILE_METHOD,
        persistedEndToEndLatencyDefinition:
          "deliveries.created_at through deliveries.delivered_at for each measured initial delivery",
        ingestionLatencyDefinition:
          "client monotonic time from starting POST /events through receiving and parsing its JSON response",
      },
      warmup:
        warmup === null
          ? { configuredEventCount: 0 }
          : {
              configuredEventCount: warmup.configuredEventCount,
              acceptedEventCount: warmup.acceptedEventCount,
              deliveredEventCount: warmup.deliveredEventCount,
              totalDurationMs: warmup.totalDurationMs,
            },
      measuredRuns,
      summary: summarizeRuns(measuredRuns),
      concurrencyCorrectness: {
        ingestion: ingestionConcurrency,
        replay: replayConcurrency,
        interpretation:
          "These checks prove idempotency correctness under bounded concurrency, not throughput capacity.",
      },
      limitations: [
        "Local single-machine development measurement; not a production capacity claim.",
        "One API process, one BullMQ worker, one PostgreSQL instance, and one Redis instance.",
        "Immediate local HTTP 200 receiver with no network distance or production contention.",
        "HookRelay remains at-least-once; a crash after receiver processing and before durable finalization can duplicate delivery.",
        "PostgreSQL-first scheduling retains a PostgreSQL/Redis dual-write gap and requires client idempotent retry; no outbox or autonomous reconciliation exists.",
        "No multi-region or high-availability guarantee is measured.",
      ],
    };
    const artifactPath = resolve(
      repositoryRoot,
      "benchmarks/results/task-9-local.json",
    );
    await mkdir(dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

    console.info(JSON.stringify({
      label: RESULT_LABEL,
      artifact: "benchmarks/results/task-9-local.json",
      runId,
      measuredRuns,
      summary: artifact.summary,
      concurrencyCorrectness: artifact.concurrencyCorrectness,
    }, null, 2));
  } finally {
    await api?.close();
    await worker?.close();
    await queue?.close();
    if (redis) await closeRedis(redis);
    await receiver.app.close();
    await database.client.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(
    "Task 9 local benchmark failed:",
    error instanceof Error ? error.message : "Unknown benchmark error.",
  );
  process.exitCode = 1;
});
