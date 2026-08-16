import { loadConfig } from "../config.js";
import { createDatabase } from "../db/client.js";
import { checkDatabase } from "../db/health.js";
import {
  createDeliveryWorker,
  type DeliveryWorkerResources,
} from "./delivery-worker.js";

const config = loadConfig();
const database = createDatabase(config.databaseUrl);
let deliveryWorker: DeliveryWorkerResources | undefined;

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
  await checkDatabase(database);
  deliveryWorker = createDeliveryWorker(database.db, config.redisUrl);
  deliveryWorker.worker.on("failed", (job, error) => {
    console.error(`Delivery job ${job?.id ?? "unknown"} failed:`, error.message);
  });
  await deliveryWorker.worker.waitUntilReady();

  console.info("HookRelay worker is ready (PostgreSQL and Redis connected).");
  await termination;
} catch (error) {
  console.error("Worker failed to start:", error);
  process.exitCode = 1;
} finally {
  await deliveryWorker?.close();
  await database.client.end({ timeout: 5 });
  console.info("Worker resources closed.");
}
