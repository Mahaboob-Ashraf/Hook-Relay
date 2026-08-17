import type { DeliveryStatus } from "../api/client";

export const statusDetails: Record<
  DeliveryStatus,
  { label: string; explanation: string }
> = {
  queued: {
    label: "Queued",
    explanation: "Waiting for the delivery worker to begin processing.",
  },
  delivering: {
    label: "Delivering",
    explanation: "The worker has durably started an outbound attempt.",
  },
  retry_scheduled: {
    label: "Retry scheduled",
    explanation: "A retryable failure occurred and another attempt is scheduled.",
  },
  delivered: {
    label: "Delivered",
    explanation: "The receiver returned a successful HTTP response.",
  },
  dead_letter: {
    label: "Dead letter",
    explanation: "Automatic delivery stopped after a terminal or exhausted failure.",
  },
};

export function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

export function exactDateTime(value: string | null): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(date);
}

export function relativeDateTime(value: string): string {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return value;
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

export function formatLatency(latencyMs: number | null): string {
  if (latencyMs === null) return "Not recorded";
  if (latencyMs < 1000) return `${latencyMs} ms`;
  return `${(latencyMs / 1000).toFixed(2)} s`;
}
