import { Queue } from "bullmq";
import {
  closeRedis,
  createBullProducerRedisClient,
  type RedisClient,
} from "../redis/client.js";
import { MAX_DELIVERY_ATTEMPTS } from "../retry/delivery-retry-policy.js";

export const DELIVERY_QUEUE_NAME = "hookrelay-deliveries";
export const DELIVERY_JOB_NAME = "deliver-webhook";
export const DELIVERY_BACKOFF_STRATEGY = "hookrelay-delivery-retry";
const PRODUCER_OPERATION_TIMEOUT_MS = 3_000;

export type DeliveryJobData = {
  deliveryId: string;
};

export interface DeliveryScheduler {
  scheduleDelivery(deliveryId: string): Promise<void>;
}

export type DeliveryQueueResources = DeliveryScheduler & {
  queue: Queue<DeliveryJobData>;
  connection: RedisClient;
  close(): Promise<void>;
};

export function createDeliveryQueue(redisUrl: string): DeliveryQueueResources {
  const connection = createBullProducerRedisClient(redisUrl);
  const queue = new Queue<DeliveryJobData>(DELIVERY_QUEUE_NAME, { connection });
  queue.on("error", () => undefined);

  return {
    queue,
    connection,
    async scheduleDelivery(deliveryId: string): Promise<void> {
      const enqueue = queue.add(
        DELIVERY_JOB_NAME,
        { deliveryId },
        {
          jobId: deliveryId,
          attempts: MAX_DELIVERY_ATTEMPTS,
          backoff: { type: DELIVERY_BACKOFF_STRATEGY },
          removeOnComplete: false,
          removeOnFail: false,
        },
      );

      let timeout: NodeJS.Timeout | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Delivery queue scheduling timed out.")),
          PRODUCER_OPERATION_TIMEOUT_MS,
        );
      });

      try {
        await Promise.race([enqueue, deadline]);
      } finally {
        if (timeout) clearTimeout(timeout);
        void enqueue.catch(() => undefined);
      }
    },
    async close(): Promise<void> {
      await queue.close();
      await closeRedis(connection);
    },
  };
}
