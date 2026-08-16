import { describe, expect, it } from "vitest";
import {
  normalizeDeliveryAttemptResult,
  normalizeLatencyMs,
} from "../src/domain/delivery-attempt-result.js";

describe("delivery attempt result normalization", () => {
  it("normalizes a successful HTTP result", () => {
    expect(
      normalizeDeliveryAttemptResult({
        kind: "http",
        statusCode: 204,
        elapsedMs: 12.4,
      }),
    ).toEqual({
      classification: "success",
      responseStatus: 204,
      latencyMs: 12,
      errorMessage: null,
    });
  });

  it("normalizes a retryable HTTP result", () => {
    expect(
      normalizeDeliveryAttemptResult({
        kind: "http",
        statusCode: 500,
        elapsedMs: 8.6,
      }),
    ).toEqual({
      classification: "retryable",
      responseStatus: 500,
      latencyMs: 9,
      errorMessage: "HTTP 500",
    });
  });

  it("normalizes a terminal HTTP result", () => {
    expect(
      normalizeDeliveryAttemptResult({
        kind: "http",
        statusCode: 400,
        elapsedMs: 3,
      }),
    ).toEqual({
      classification: "terminal",
      responseStatus: 400,
      latencyMs: 3,
      errorMessage: "HTTP 400",
    });
  });

  it("normalizes a timeout without inventing an HTTP status", () => {
    expect(
      normalizeDeliveryAttemptResult({ kind: "timeout", elapsedMs: 15.2 }),
    ).toEqual({
      classification: "retryable",
      responseStatus: null,
      latencyMs: 15,
      errorMessage: "Webhook request timed out",
    });
  });

  it("normalizes known and unknown network errors without stack traces", () => {
    expect(
      normalizeDeliveryAttemptResult({
        kind: "network",
        elapsedMs: 2,
        error: { cause: { code: "ECONNREFUSED" } },
      }),
    ).toMatchObject({
      classification: "retryable",
      responseStatus: null,
      errorMessage: "Network error: connection refused",
    });
    expect(
      normalizeDeliveryAttemptResult({
        kind: "network",
        elapsedMs: 2,
        error: new Error("secret-bearing arbitrary remote error"),
      }).errorMessage,
    ).toBe("Network error");
  });

  it("always returns a nonnegative integer latency", () => {
    expect(normalizeLatencyMs(-10)).toBe(0);
    expect(normalizeLatencyMs(Number.NaN)).toBe(0);
    expect(normalizeLatencyMs(10.8)).toBe(11);
  });
});
