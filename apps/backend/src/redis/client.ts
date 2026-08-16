import { Redis } from "ioredis";

export type RedisClient = Redis;

function ignoreEmittedConnectionErrors(client: RedisClient): RedisClient {
  client.on("error", () => undefined);
  return client;
}

export function createRedisClient(redisUrl: string): RedisClient {
  const client = new Redis(redisUrl, {
    lazyConnect: true,
    enableReadyCheck: true,
    maxRetriesPerRequest: 1,
    retryStrategy: (attempt) => Math.min(attempt * 100, 1_000),
  });

  return ignoreEmittedConnectionErrors(client);
}

export function createBullProducerRedisClient(redisUrl: string): RedisClient {
  return ignoreEmittedConnectionErrors(new Redis(redisUrl, {
    lazyConnect: true,
    enableReadyCheck: true,
    connectTimeout: 2_000,
    commandTimeout: 2_500,
    maxRetriesPerRequest: 1,
    retryStrategy: (attempt) => Math.min(attempt * 100, 1_000),
  }));
}

export function createBullWorkerRedisClient(redisUrl: string): RedisClient {
  return ignoreEmittedConnectionErrors(new Redis(redisUrl, {
    enableReadyCheck: true,
    maxRetriesPerRequest: null,
    retryStrategy: (attempt) => Math.min(attempt * 100, 2_000),
  }));
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

  if (client.status === "ready") {
    await client.quit();
    return;
  }

  client.disconnect();
}
