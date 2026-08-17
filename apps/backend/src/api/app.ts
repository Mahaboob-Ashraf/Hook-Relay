import Fastify, { type FastifyInstance } from "fastify";
import type { AppDatabase } from "../db/client.js";
import type { DeliveryScheduler } from "../queue/delivery-queue.js";
import { registerDeliveryReadRoutes } from "./delivery-read-routes.js";
import { registerDomainRoutes } from "./domain-routes.js";
import { registerMetricsRoutes } from "./metrics-routes.js";

export type DependencyChecks = {
  postgres: () => Promise<void>;
  redis: () => Promise<void>;
};

type DependencyStatus =
  | { status: "up" }
  | { status: "down"; error: string };

const SAFE_DEPENDENCY_ERROR = "Dependency check failed.";

export type BuildAppOptions = {
  dependencyChecks: DependencyChecks;
  database?: AppDatabase;
  deliveryScheduler?: DeliveryScheduler;
  logger?: boolean;
};

async function runCheck(check: () => Promise<void>): Promise<DependencyStatus> {
  try {
    await check();
    return { status: "up" };
  } catch {
    return {
      status: "down",
      error: SAFE_DEPENDENCY_ERROR,
    };
  }
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  app.get("/health/live", async () => ({ status: "alive" }));

  app.get("/health/ready", async (_request, reply) => {
    const [postgres, redis] = await Promise.all([
      runCheck(options.dependencyChecks.postgres),
      runCheck(options.dependencyChecks.redis),
    ]);
    const ready = postgres.status === "up" && redis.status === "up";

    return reply.code(ready ? 200 : 503).send({
      status: ready ? "ready" : "not_ready",
      dependencies: { postgres, redis },
    });
  });

  if (options.database) {
    registerDomainRoutes(app, options.database, options.deliveryScheduler);
    registerDeliveryReadRoutes(app, options.database);
    registerMetricsRoutes(app, options.database);
  }

  app.setErrorHandler((error, request, reply) => {
    const statusCode =
      typeof error === "object" && error !== null && "statusCode" in error
        ? error.statusCode
        : undefined;

    if (statusCode === 400) {
      return reply.code(400).send({
        error: {
          code: "validation_error",
          message: "Invalid request body.",
        },
      });
    }

    request.log.error({ error }, "Unhandled request error");
    return reply.code(500).send({
      error: {
        code: "internal_error",
        message: "An internal error occurred.",
      },
    });
  });

  return app;
}
