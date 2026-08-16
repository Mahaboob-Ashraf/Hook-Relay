export const MAX_DELIVERY_ATTEMPTS = 5;

export type DeliveryFailureKind = "http" | "network" | "timeout";
export type DeliveryResultClassification = "success" | "retryable" | "terminal";

export type DeliveryRetryPolicy = Readonly<{
  maxAttempts: number;
  retryDelaysMs: readonly number[];
}>;

export const PRODUCTION_RETRY_POLICY: DeliveryRetryPolicy = Object.freeze({
  maxAttempts: MAX_DELIVERY_ATTEMPTS,
  retryDelaysMs: Object.freeze([5_000, 15_000, 45_000, 120_000]),
});

export function createDeliveryRetryPolicy(
  retryDelaysMs: readonly number[],
): DeliveryRetryPolicy {
  if (
    retryDelaysMs.length !== MAX_DELIVERY_ATTEMPTS - 1 ||
    retryDelaysMs.some((delay) => !Number.isFinite(delay) || delay < 0)
  ) {
    throw new Error(
      `A delivery retry policy requires ${MAX_DELIVERY_ATTEMPTS - 1} nonnegative delays.`,
    );
  }

  return Object.freeze({
    maxAttempts: MAX_DELIVERY_ATTEMPTS,
    retryDelaysMs: Object.freeze([...retryDelaysMs]),
  });
}

export function classifyDeliveryResult(
  kind: DeliveryFailureKind,
  statusCode?: number,
): DeliveryResultClassification {
  if (kind === "network" || kind === "timeout") return "retryable";
  if (statusCode === undefined) {
    throw new Error("An HTTP delivery result requires a status code.");
  }
  if (statusCode >= 200 && statusCode <= 299) return "success";
  if (
    statusCode === 408 ||
    statusCode === 429 ||
    (statusCode >= 500 && statusCode <= 599)
  ) {
    return "retryable";
  }
  return "terminal";
}

export function getRetryDelayMs(
  failedAttemptNumber: number,
  policy: DeliveryRetryPolicy = PRODUCTION_RETRY_POLICY,
): number | undefined {
  if (
    !Number.isInteger(failedAttemptNumber) ||
    failedAttemptNumber < 1 ||
    failedAttemptNumber >= policy.maxAttempts
  ) {
    return undefined;
  }
  return policy.retryDelaysMs[failedAttemptNumber - 1];
}

export function hasRetryRemaining(
  failedAttemptNumber: number,
  policy: DeliveryRetryPolicy = PRODUCTION_RETRY_POLICY,
): boolean {
  return getRetryDelayMs(failedAttemptNumber, policy) !== undefined;
}
