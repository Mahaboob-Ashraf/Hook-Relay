import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { z } from "zod";
import {
  isWebhookTimestampFresh,
  parseWebhookSignature,
  parseWebhookTimestamp,
  verifyWebhookSignature,
} from "../signing/webhook-signature.js";

const querySchema = z.object({
  scenario: z.string().trim().min(1).max(100),
  fail_first: z.coerce.number().int().min(0).max(100).default(0),
});

const resetSchema = z.object({
  scenario: z.string().trim().min(1).max(100),
}).strict();

const metadataSchema = z.object({
  eventId: z.uuid(),
  eventType: z.string().trim().min(1),
  timestamp: z.string().min(1),
  signature: z.string().min(1),
});

export type DemoScenarioState = {
  validRequestCount: number;
  lastRequest: {
    eventId: string;
    eventType: string;
    timestamp: string;
    rawBody: string;
    payload: unknown;
  };
};

export type DemoReceiverResources = {
  app: FastifyInstance;
  getScenarioState(scenario: string): DemoScenarioState | undefined;
};

export type DemoReceiverOptions = {
  secret: string;
  maxAgeSeconds?: number;
  logger?: boolean;
  nowSeconds?: () => number;
};

function validationError(reply: FastifyReply, message: string) {
  return reply.code(400).send({
    error: { code: "invalid_request", message },
  });
}

function authenticationError(reply: FastifyReply, code: string, message: string) {
  return reply.code(401).send({ error: { code, message } });
}

export function createDemoReceiver(
  options: DemoReceiverOptions,
): DemoReceiverResources {
  const app = Fastify({ logger: options.logger ?? false });
  const scenarios = new Map<string, DemoScenarioState>();
  const maxAgeSeconds = options.maxAgeSeconds ?? 300;
  const nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));

  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_request, body, done) => done(null, body),
  );

  app.post("/demo/webhook", async (request, reply) => {
    const query = querySchema.safeParse(request.query);
    if (!query.success) {
      return validationError(reply, "scenario and a bounded nonnegative fail_first are required.");
    }

    const metadata = metadataSchema.safeParse({
      eventId: request.headers["x-hookrelay-event-id"],
      eventType: request.headers["x-hookrelay-event-type"],
      timestamp: request.headers["x-hookrelay-timestamp"],
      signature: request.headers["x-hookrelay-signature"],
    });
    if (!metadata.success) {
      return validationError(reply, "Required HookRelay webhook headers are missing or malformed.");
    }

    if (!parseWebhookSignature(metadata.data.signature)) {
      return validationError(reply, "X-HookRelay-Signature must use sha256=<64 hex characters>.");
    }
    if (parseWebhookTimestamp(metadata.data.timestamp) === undefined) {
      return validationError(reply, "X-HookRelay-Timestamp must be Unix seconds.");
    }
    if (
      !isWebhookTimestampFresh(
        metadata.data.timestamp,
        nowSeconds(),
        maxAgeSeconds,
      )
    ) {
      return authenticationError(
        reply,
        "stale_timestamp",
        "Webhook timestamp is outside the accepted time window.",
      );
    }

    const rawBody = typeof request.body === "string" ? request.body : "";
    if (
      !verifyWebhookSignature(
        options.secret,
        metadata.data.timestamp,
        rawBody,
        metadata.data.signature,
      )
    ) {
      return authenticationError(
        reply,
        "invalid_signature",
        "Webhook signature verification failed.",
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return validationError(reply, "Webhook body must be valid JSON.");
    }

    const previous = scenarios.get(query.data.scenario);
    const receivedAttempt = (previous?.validRequestCount ?? 0) + 1;
    scenarios.set(query.data.scenario, {
      validRequestCount: receivedAttempt,
      lastRequest: {
        eventId: metadata.data.eventId,
        eventType: metadata.data.eventType,
        timestamp: metadata.data.timestamp,
        rawBody,
        payload,
      },
    });

    const accepted = receivedAttempt > query.data.fail_first;
    return reply.code(accepted ? 200 : 500).send({
      scenario: query.data.scenario,
      receivedAttempt,
      eventId: metadata.data.eventId,
      eventType: metadata.data.eventType,
      accepted,
    });
  });

  app.post("/demo/reset", async (request, reply) => {
    let body: unknown;
    try {
      body = JSON.parse(typeof request.body === "string" ? request.body : "");
    } catch {
      return validationError(reply, "Reset body must be valid JSON.");
    }
    const parsed = resetSchema.safeParse(body);
    if (!parsed.success) {
      return validationError(reply, "A non-empty scenario is required.");
    }
    scenarios.delete(parsed.data.scenario);
    return reply.send({ scenario: parsed.data.scenario, reset: true });
  });

  return {
    app,
    getScenarioState: (scenario) => scenarios.get(scenario),
  };
}

