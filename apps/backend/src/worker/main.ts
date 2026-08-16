import { loadConfig } from "../config.js";
import { createDatabase } from "../db/client.js";
import { checkDatabase } from "../db/health.js";
import { checkRedis, closeRedis, createRedisClient } from "../redis/client.js";

const config = loadConfig();
const database = createDatabase(config.databaseUrl);
const redis = createRedisClient(config.redisUrl);

let resolveTermination: (() => void) | undefined;
const termination = new Promise<void>((resolve) => {
  resolveTermination = resolve;
});

function requestShutdown(signal: NodeJS.Signals): void {
  console.info(`Worker received ${signal}; shutting down.`);
  resolveTermination?.();
}

process.once("SIGINT", () => requestShutdown("SIGINT"));
process.once("SIGTERM", () => requestShutdown("SIGTERM"));

try {
  const dependencyResults = await Promise.allSettled([
    checkDatabase(database),
    checkRedis(redis),
  ]);
  const failures = dependencyResults.flatMap((result, index) => {
    if (result.status === "fulfilled") return [];
    const dependency = index === 0 ? "PostgreSQL" : "Redis";
    const message = result.reason instanceof Error
      ? result.reason.message
      : "Unknown dependency error";
    return [`${dependency}: ${message}`];
  });

  if (failures.length > 0) {
    throw new Error(`Worker dependencies unavailable: ${failures.join("; ")}`);
  }

  console.info("HookRelay worker is ready (PostgreSQL and Redis connected).");
  await termination;
} catch (error) {
  console.error("Worker failed to start:", error);
  process.exitCode = 1;
} finally {
  await Promise.all([
    database.client.end({ timeout: 5 }),
    closeRedis(redis),
  ]);
  console.info("Worker resources closed.");
}
