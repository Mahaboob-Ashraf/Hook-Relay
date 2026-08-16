import {
  classifyDeliveryResult,
  type DeliveryResultClassification,
} from "../retry/delivery-retry-policy.js";

export type NormalizedDeliveryAttemptResult = {
  classification: DeliveryResultClassification;
  responseStatus: number | null;
  latencyMs: number;
  errorMessage: string | null;
};

export type DeliveryAttemptOutcome =
  | { kind: "http"; statusCode: number; elapsedMs: number }
  | { kind: "timeout"; elapsedMs: number }
  | { kind: "network"; elapsedMs: number; error: unknown };

export function normalizeLatencyMs(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs)) return 0;
  return Math.max(0, Math.round(elapsedMs));
}

function findNetworkErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if ("code" in error && typeof error.code === "string") return error.code;
  if ("cause" in error && error.cause !== error) {
    return findNetworkErrorCode(error.cause);
  }
  return undefined;
}

export function normalizeNetworkError(error: unknown): string {
  switch (findNetworkErrorCode(error)) {
    case "ECONNREFUSED":
      return "Network error: connection refused";
    case "ECONNRESET":
      return "Network error: connection reset";
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "Network error: DNS lookup failed";
    case "ETIMEDOUT":
      return "Network error: connection timed out";
    default:
      return "Network error";
  }
}

export function normalizeDeliveryAttemptResult(
  outcome: DeliveryAttemptOutcome,
): NormalizedDeliveryAttemptResult {
  const latencyMs = normalizeLatencyMs(outcome.elapsedMs);
  if (outcome.kind === "timeout") {
    return {
      classification: classifyDeliveryResult("timeout"),
      responseStatus: null,
      latencyMs,
      errorMessage: "Webhook request timed out",
    };
  }
  if (outcome.kind === "network") {
    return {
      classification: classifyDeliveryResult("network"),
      responseStatus: null,
      latencyMs,
      errorMessage: normalizeNetworkError(outcome.error),
    };
  }

  const classification = classifyDeliveryResult("http", outcome.statusCode);
  return {
    classification,
    responseStatus: outcome.statusCode,
    latencyMs,
    errorMessage: classification === "success" ? null : `HTTP ${outcome.statusCode}`,
  };
}
