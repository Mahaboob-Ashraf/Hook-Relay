export type DeliveryStatus =
  | "queued"
  | "delivering"
  | "retry_scheduled"
  | "delivered"
  | "dead_letter";

export type DeliverySummary = {
  id: string;
  status: DeliveryStatus;
  attemptCount: number;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
  replayedFromDeliveryId: string | null;
  createdAt: string;
  event: {
    id: string;
    eventType: string;
    createdAt: string;
  };
  endpoint: {
    id: string;
    name: string;
    url: string;
  };
};

export type DeliveryAttempt = {
  id: string;
  attemptNumber: number;
  startedAt: string;
  completedAt: string | null;
  responseStatus: number | null;
  latencyMs: number | null;
  errorMessage: string | null;
};

export type RelatedDelivery = {
  id: string;
  status: DeliveryStatus;
  createdAt: string;
  replayedFromDeliveryId: string | null;
};

export type DeliveryDetail = Omit<DeliverySummary, "event"> & {
  event: DeliverySummary["event"] & { payload: unknown };
};

export type DeliveryDetailResponse = {
  delivery: DeliveryDetail;
  attempts: DeliveryAttempt[];
  relatedDeliveries: RelatedDelivery[];
};

export type DeliveryListResponse = {
  deliveries: DeliverySummary[];
  page: { limit: number; offset: number; total: number };
};

export type ReadinessResponse = {
  status: "ready" | "not_ready";
  dependencies: {
    postgres: { status: "up" | "down"; error?: string };
    redis: { status: "up" | "down"; error?: string };
  };
};

export type ReplayResponse = {
  sourceDelivery: { id: string; status: "dead_letter" };
  replayDelivery: {
    id: string;
    eventId: string;
    endpointId: string;
    status: DeliveryStatus;
    attemptCount: number;
    nextAttemptAt: string | null;
    deliveredAt: string | null;
    replayedFromDeliveryId: string;
    createdAt: string;
  };
  reused: boolean;
  scheduled: boolean;
  durableAccepted?: boolean;
  error?: { code: string; message: string };
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function parseResponse<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => undefined)) as T | undefined;
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body
        ? String((body as { error?: { message?: string } }).error?.message ?? "Request failed.")
        : "Request failed.";
    throw new ApiError(message, response.status, body);
  }
  if (body === undefined) throw new ApiError("The API returned an empty response.", response.status, body);
  return body;
}

export async function listDeliveries(
  options: {
    status?: DeliveryStatus;
    limit?: number;
    offset?: number;
    signal?: AbortSignal;
  } = {},
): Promise<DeliveryListResponse> {
  const query = new URLSearchParams();
  if (options.status) query.set("status", options.status);
  query.set("limit", String(options.limit ?? 50));
  query.set("offset", String(options.offset ?? 0));
  return parseResponse(
    await fetch(`/api/deliveries?${query.toString()}`, { signal: options.signal }),
  );
}

export async function getDelivery(
  deliveryId: string,
  signal?: AbortSignal,
): Promise<DeliveryDetailResponse> {
  return parseResponse(
    await fetch(`/api/deliveries/${encodeURIComponent(deliveryId)}`, { signal }),
  );
}

export async function getReadiness(signal?: AbortSignal): Promise<ReadinessResponse> {
  const response = await fetch("/api/health/ready", { signal });
  const body = (await response.json().catch(() => undefined)) as ReadinessResponse | undefined;
  if (body && (response.ok || response.status === 503)) return body;
  throw new ApiError("Readiness check failed.", response.status, body);
}

export async function replayDelivery(
  sourceDeliveryId: string,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<ReplayResponse> {
  return parseResponse(
    await fetch(`/api/deliveries/${encodeURIComponent(sourceDeliveryId)}/replay`, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      signal,
    }),
  );
}
