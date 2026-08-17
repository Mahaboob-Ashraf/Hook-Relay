import { and, asc, count, desc, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { AppDatabase } from "../db/client.js";
import {
  deliveries,
  deliveryAttempts,
  events,
  webhookEndpoints,
} from "../db/schema.js";

const deliveryStatusSchema = z.enum([
  "queued",
  "delivering",
  "retry_scheduled",
  "delivered",
  "dead_letter",
]);

const deliveryListQuerySchema = z
  .object({
    status: deliveryStatusSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  })
  .strict();

const deliveryParamsSchema = z.object({ deliveryId: z.uuid() }).strict();

const deliverySummarySelection = {
  id: deliveries.id,
  status: deliveries.status,
  attemptCount: deliveries.attemptCount,
  nextAttemptAt: deliveries.nextAttemptAt,
  deliveredAt: deliveries.deliveredAt,
  replayedFromDeliveryId: deliveries.replayedFromDeliveryId,
  createdAt: deliveries.createdAt,
  eventId: events.id,
  eventType: events.eventType,
  eventCreatedAt: events.createdAt,
  endpointId: webhookEndpoints.id,
  endpointName: webhookEndpoints.name,
  endpointUrl: webhookEndpoints.url,
};

type DeliverySummaryRow = {
  id: string;
  status: "queued" | "delivering" | "retry_scheduled" | "delivered" | "dead_letter";
  attemptCount: number;
  nextAttemptAt: Date | null;
  deliveredAt: Date | null;
  replayedFromDeliveryId: string | null;
  createdAt: Date;
  eventId: string;
  eventType: string;
  eventCreatedAt: Date;
  endpointId: string;
  endpointName: string;
  endpointUrl: string;
};

function sendValidationError(
  reply: FastifyReply,
  message: string,
  issues: z.core.$ZodIssue[],
) {
  return reply.code(400).send({
    error: {
      code: "validation_error",
      message,
      details: issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    },
  });
}

function toDeliverySummary(row: DeliverySummaryRow) {
  return {
    id: row.id,
    status: row.status,
    attemptCount: row.attemptCount,
    nextAttemptAt: row.nextAttemptAt,
    deliveredAt: row.deliveredAt,
    replayedFromDeliveryId: row.replayedFromDeliveryId,
    createdAt: row.createdAt,
    event: {
      id: row.eventId,
      eventType: row.eventType,
      createdAt: row.eventCreatedAt,
    },
    endpoint: {
      id: row.endpointId,
      name: row.endpointName,
      url: row.endpointUrl,
    },
  };
}

export function registerDeliveryReadRoutes(
  app: FastifyInstance,
  db: AppDatabase,
): void {
  app.get("/deliveries", async (request, reply) => {
    const queryResult = deliveryListQuerySchema.safeParse(request.query);
    if (!queryResult.success) {
      return sendValidationError(
        reply,
        "Invalid delivery query.",
        queryResult.error.issues,
      );
    }

    const { status, limit, offset } = queryResult.data;
    const statusFilter = status ? eq(deliveries.status, status) : undefined;
    const [rows, totalRows] = await Promise.all([
      db
        .select(deliverySummarySelection)
        .from(deliveries)
        .innerJoin(events, eq(deliveries.eventId, events.id))
        .innerJoin(
          webhookEndpoints,
          eq(deliveries.endpointId, webhookEndpoints.id),
        )
        .where(statusFilter)
        .orderBy(desc(deliveries.createdAt), desc(deliveries.id))
        .limit(limit)
        .offset(offset),
      db
        .select({ value: count() })
        .from(deliveries)
        .where(statusFilter),
    ]);

    return reply.send({
      deliveries: rows.map(toDeliverySummary),
      page: {
        limit,
        offset,
        total: totalRows[0]?.value ?? 0,
      },
    });
  });

  app.get("/deliveries/:deliveryId", async (request, reply) => {
    const paramsResult = deliveryParamsSchema.safeParse(request.params);
    if (!paramsResult.success) {
      return sendValidationError(
        reply,
        "Invalid delivery ID.",
        paramsResult.error.issues,
      );
    }

    const [row] = await db
      .select({
        ...deliverySummarySelection,
        eventPayload: events.payload,
      })
      .from(deliveries)
      .innerJoin(events, eq(deliveries.eventId, events.id))
      .innerJoin(
        webhookEndpoints,
        eq(deliveries.endpointId, webhookEndpoints.id),
      )
      .where(eq(deliveries.id, paramsResult.data.deliveryId))
      .limit(1);

    if (!row) {
      return reply.code(404).send({
        error: {
          code: "delivery_not_found",
          message: "Delivery was not found.",
        },
      });
    }

    const [attempts, relatedDeliveries] = await Promise.all([
      db
        .select({
          id: deliveryAttempts.id,
          attemptNumber: deliveryAttempts.attemptNumber,
          startedAt: deliveryAttempts.startedAt,
          completedAt: deliveryAttempts.completedAt,
          responseStatus: deliveryAttempts.responseStatus,
          latencyMs: deliveryAttempts.latencyMs,
          errorMessage: deliveryAttempts.errorMessage,
        })
        .from(deliveryAttempts)
        .where(eq(deliveryAttempts.deliveryId, row.id))
        .orderBy(asc(deliveryAttempts.attemptNumber)),
      db
        .select({
          id: deliveries.id,
          status: deliveries.status,
          createdAt: deliveries.createdAt,
          replayedFromDeliveryId: deliveries.replayedFromDeliveryId,
        })
        .from(deliveries)
        .where(
          and(
            eq(deliveries.eventId, row.eventId),
            eq(deliveries.endpointId, row.endpointId),
          ),
        )
        .orderBy(asc(deliveries.createdAt), asc(deliveries.id)),
    ]);

    const summary = toDeliverySummary(row);
    return reply.send({
      delivery: {
        ...summary,
        event: {
          ...summary.event,
          payload: row.eventPayload,
        },
      },
      attempts,
      relatedDeliveries,
    });
  });
}
