import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AppDatabase } from "../db/client.js";
import { deliveries, deliveryAttempts } from "../db/schema.js";

type MetricsRow = {
  delivery_total: number;
  queued_count: number;
  delivering_count: number;
  retry_scheduled_count: number;
  delivered_count: number;
  dead_letter_count: number;
  attempt_total: number;
  completed_count: number;
  incomplete_count: number;
  retry_attempt_count: number;
  latency_sample_count: number;
  latency_average: number | null;
  latency_p50: number | null;
  latency_p95: number | null;
  latency_max: number | null;
};

export const LATENCY_PERCENTILE_METHOD =
  "PostgreSQL percentile_disc nearest-rank over completed attempts with a persisted latency_ms value.";

export function registerMetricsRoutes(
  app: FastifyInstance,
  db: AppDatabase,
): void {
  app.get("/metrics", async (_request, reply) => {
    // One PostgreSQL statement gives every aggregate the same MVCC snapshot.
    const rows = await db.execute<MetricsRow>(sql`
      with delivery_metrics as (
        select
          count(*)::integer as delivery_total,
          count(*) filter (where status = 'queued')::integer as queued_count,
          count(*) filter (where status = 'delivering')::integer as delivering_count,
          count(*) filter (where status = 'retry_scheduled')::integer as retry_scheduled_count,
          count(*) filter (where status = 'delivered')::integer as delivered_count,
          count(*) filter (where status = 'dead_letter')::integer as dead_letter_count
        from ${deliveries}
      ),
      attempt_metrics as (
        select
          count(*)::integer as attempt_total,
          count(*) filter (where completed_at is not null)::integer as completed_count,
          count(*) filter (where completed_at is null)::integer as incomplete_count,
          count(*) filter (where attempt_number > 1)::integer as retry_attempt_count,
          count(latency_ms) filter (
            where completed_at is not null and latency_ms is not null
          )::integer as latency_sample_count,
          avg(latency_ms) filter (
            where completed_at is not null and latency_ms is not null
          )::double precision as latency_average,
          percentile_disc(0.50) within group (order by latency_ms) filter (
            where completed_at is not null and latency_ms is not null
          )::integer as latency_p50,
          percentile_disc(0.95) within group (order by latency_ms) filter (
            where completed_at is not null and latency_ms is not null
          )::integer as latency_p95,
          max(latency_ms) filter (
            where completed_at is not null and latency_ms is not null
          )::integer as latency_max
        from ${deliveryAttempts}
      )
      select * from delivery_metrics cross join attempt_metrics
    `);
    const row = rows[0];
    if (!row) throw new Error("PostgreSQL returned no operational metrics row.");

    const terminal = row.delivered_count + row.dead_letter_count;
    return reply.send({
      generatedAt: new Date().toISOString(),
      source: "postgresql",
      deliveries: {
        total: row.delivery_total,
        byStatus: {
          queued: row.queued_count,
          delivering: row.delivering_count,
          retryScheduled: row.retry_scheduled_count,
          delivered: row.delivered_count,
          deadLetter: row.dead_letter_count,
        },
        terminal,
        terminalSuccessRate:
          terminal === 0 ? null : row.delivered_count / terminal,
      },
      attempts: {
        total: row.attempt_total,
        completed: row.completed_count,
        incomplete: row.incomplete_count,
        retryAttempts: row.retry_attempt_count,
        latencyMs: {
          sampleCount: row.latency_sample_count,
          average: row.latency_average,
          p50: row.latency_p50,
          p95: row.latency_p95,
          max: row.latency_max,
        },
      },
    });
  });
}
