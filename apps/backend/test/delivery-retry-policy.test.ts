import { describe, expect, it } from "vitest";
import {
  classifyDeliveryResult,
  getRetryDelayMs,
  hasRetryRemaining,
  MAX_DELIVERY_ATTEMPTS,
  PRODUCTION_RETRY_POLICY,
} from "../src/retry/delivery-retry-policy.js";

describe("delivery retry classification", () => {
  it.each([200, 204])("classifies HTTP %i as success", (statusCode) => {
    expect(classifyDeliveryResult("http", statusCode)).toBe("success");
  });

  it.each([400, 401, 403, 404, 409, 422])(
    "classifies HTTP %i as terminal",
    (statusCode) => {
      expect(classifyDeliveryResult("http", statusCode)).toBe("terminal");
    },
  );

  it.each([408, 429, 500, 502, 503])(
    "classifies HTTP %i as retryable",
    (statusCode) => {
      expect(classifyDeliveryResult("http", statusCode)).toBe("retryable");
    },
  );

  it("classifies network errors and HookRelay timeouts as retryable", () => {
    expect(classifyDeliveryResult("network")).toBe("retryable");
    expect(classifyDeliveryResult("timeout")).toBe("retryable");
  });
});

describe("delivery retry backoff", () => {
  it("defines five total attempts and the locked production schedule", () => {
    expect(MAX_DELIVERY_ATTEMPTS).toBe(5);
    expect(PRODUCTION_RETRY_POLICY.maxAttempts).toBe(5);
    expect(PRODUCTION_RETRY_POLICY.retryDelaysMs).toEqual([
      5_000,
      15_000,
      45_000,
      120_000,
    ]);
  });

  it.each([
    [1, 5_000],
    [2, 15_000],
    [3, 45_000],
    [4, 120_000],
  ])(
    "maps failure after attempt %i to a %i ms delay",
    (failedAttemptNumber, expectedDelayMs) => {
      expect(getRetryDelayMs(failedAttemptNumber)).toBe(expectedDelayMs);
      expect(hasRetryRemaining(failedAttemptNumber)).toBe(true);
    },
  );

  it("does not schedule another retry after attempt five", () => {
    expect(getRetryDelayMs(5)).toBeUndefined();
    expect(hasRetryRemaining(5)).toBe(false);
  });
});
