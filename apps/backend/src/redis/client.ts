import { Redis } from "ioredis";

export type RedisClient = Redis;

export function createRedisClient(redisUrl: string): RedisClient {
  const client = new Redis(redisUrl, {
    lazyConnect: true,
    enableReadyCheck: true,
    maxRetriesPerRequest: 1,
    retryStrategy: (attempt) => Math.min(attempt * 100, 1_000),
  });

  // ioredis emits connection errors. A listener prevents an unavailable dependency
  // from becoming an uncaught EventEmitter error; readiness still reports failure.
  client.on("error", () => undefined);

  return client;
}

export async function checkRedis(client: RedisClient): Promise<void> {
  const response = await client.ping();
  if (response !== "PONG") {
    throw new Error(`Unexpected Redis PING response: ${response}`);
  }
}

export async function closeRedis(client: RedisClient): Promise<void> {
  if (client.status === "wait" || client.status === "end") {
    return;
  }

  await client.quit();
}
