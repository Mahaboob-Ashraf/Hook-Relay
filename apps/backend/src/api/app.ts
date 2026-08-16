import Fastify, { type FastifyInstance } from "fastify";

export type DependencyChecks = {
  postgres: () => Promise<void>;
  redis: () => Promise<void>;
};

type DependencyStatus =
  | { status: "up" }
  | { status: "down"; error: string };

export type BuildAppOptions = {
  dependencyChecks: DependencyChecks;
  logger?: boolean;
};

async function runCheck(check: () => Promise<void>): Promise<DependencyStatus> {
  try {
    await check();
    return { status: "up" };
  } catch (error) {
    return {
      status: "down",
      error: error instanceof Error ? error.message : "Unknown dependency error",
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

  return app;
}

