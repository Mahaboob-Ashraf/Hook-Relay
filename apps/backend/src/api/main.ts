import { buildApp } from "./app.js";
import { loadConfig } from "../config.js";
import { createDatabase } from "../db/client.js";
import { checkDatabase } from "../db/health.js";
import { checkRedis, closeRedis, createRedisClient } from "../redis/client.js";
import { createDeliveryQueue } from "../queue/delivery-queue.js";

const config = loadConfig();
const database = createDatabase(config.databaseUrl);
const redis = createRedisClient(config.redisUrl);
const deliveryQueue = createDeliveryQueue(config.redisUrl);

const app = buildApp({
  logger: true,
  database: database.db,
  deliveryScheduler: deliveryQueue,
  dependencyChecks: {
    postgres: () => checkDatabase(database),
    redis: () => checkRedis(redis),
  },
});

app.addHook("onClose", async () => {
  await Promise.all([
    database.client.end({ timeout: 5 }),
    closeRedis(redis),
    deliveryQueue.close(),
  ]);
});

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "Shutting down API");
  await app.close();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ port: config.backendPort, host: "0.0.0.0" });
} catch (error) {
  app.log.error(error, "API failed to start");
  await app.close();
  process.exitCode = 1;
}
