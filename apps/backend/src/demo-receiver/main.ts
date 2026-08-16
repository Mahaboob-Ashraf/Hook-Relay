import { loadDemoReceiverConfig } from "../config.js";
import { createDemoReceiver } from "./app.js";

const config = loadDemoReceiverConfig();
const receiver = createDemoReceiver({
  secret: config.secret,
  maxAgeSeconds: config.maxAgeSeconds,
  logger: true,
});

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  receiver.app.log.info({ signal }, "Shutting down demo receiver");
  await receiver.app.close();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await receiver.app.listen({ port: config.port, host: "0.0.0.0" });
} catch (error) {
  receiver.app.log.error(error, "Demo receiver failed to start");
  await receiver.app.close();
  process.exitCode = 1;
}

