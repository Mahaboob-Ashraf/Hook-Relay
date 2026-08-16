import { asc, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { AppDatabase } from "../db/client.js";
import { webhookEndpoints } from "../db/schema.js";
import {
  IdempotencyConflictError,
  ingestEvent,
} from "../domain/ingestion.js";
import type { DeliveryScheduler } from "../queue/delivery-queue.js";

const endpointBodySchema = z.object({
  name: z.string().trim().min(1),
  url: z.url().refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  }, "URL must use HTTP or HTTPS"),
  signingSecret: z.string().trim().min(1),
}).strict();

const eventBodySchema = z.object({
  endpointId: z.uuid(),
  eventType: z.string().trim().min(1),
  payload: z.json(),
}).strict();

const idempotencyKeySchema = z.string().trim().min(1);

function sendValidationError(
  reply: FastifyReply,
  message: string,
  issues?: z.core.$ZodIssue[],
) {
  return reply.code(400).send({
    error: {
      code: "validation_error",
      message,
      ...(issues
        ? {
            details: issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          }
        : {}),
    },
  });
}

export function registerDomainRoutes(
  app: FastifyInstance,
  db: AppDatabase,
  scheduler?: DeliveryScheduler,
): void {
  app.post("/endpoints", async (request, reply) => {
    const parsed = endpointBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendValidationError(reply, "Invalid endpoint body.", parsed.error.issues);
    }

    const [endpoint] = await db
      .insert(webhookEndpoints)
      .values(parsed.data)
      .returning({
        id: webhookEndpoints.id,
        name: webhookEndpoints.name,
        url: webhookEndpoints.url,
        createdAt: webhookEndpoints.createdAt,
      });

    return reply.code(201).send({ endpoint });
  });

  app.get("/endpoints", async (_request, reply) => {
    const endpoints = await db
      .select({
        id: webhookEndpoints.id,
        name: webhookEndpoints.name,
        url: webhookEndpoints.url,
        createdAt: webhookEndpoints.createdAt,
      })
      .from(webhookEndpoints)
      .orderBy(asc(webhookEndpoints.createdAt), asc(webhookEndpoints.id));

    return reply.send({ endpoints });
  });

  app.post("/events", async (request, reply) => {
    const keyResult = idempotencyKeySchema.safeParse(request.headers["idempotency-key"]);
    if (!keyResult.success) {
      return sendValidationError(reply, "Idempotency-Key header is required and must be non-empty.");
    }

    const bodyResult = eventBodySchema.safeParse(request.body);
    if (!bodyResult.success) {
      return sendValidationError(reply, "Invalid event body.", bodyResult.error.issues);
    }

    const [endpoint] = await db
      .select({ id: webhookEndpoints.id })
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, bodyResult.data.endpointId))
      .limit(1);

    if (!endpoint) {
      return reply.code(404).send({
        error: {
          code: "endpoint_not_found",
          message: "Webhook endpoint was not found.",
        },
      });
    }

    try {
      const result = await ingestEvent(db, {
        ...bodyResult.data,
        idempotencyKey: keyResult.data,
      });

      if (scheduler) {
        try {
          await scheduler.scheduleDelivery(result.delivery.id);
        } catch (error) {
          request.log.warn(
            { error, deliveryId: result.delivery.id },
            "Durable delivery accepted but queue scheduling failed",
          );
          return reply.code(503).send({
            error: {
              code: "delivery_scheduling_unavailable",
              message:
                "Event and delivery were durably accepted, but scheduling failed. Retry this request with the same Idempotency-Key.",
            },
            durableAccepted: true,
            scheduled: false,
            ...result,
          });
        }
      }

      return reply.code(result.reused ? 200 : 201).send(result);
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        return reply.code(409).send({
          error: {
            code: "idempotency_conflict",
            message: error.message,
          },
        });
      }

      throw error;
    }
  });
}
