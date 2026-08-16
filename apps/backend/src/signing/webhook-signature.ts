import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE_PATTERN = /^sha256=([0-9a-f]{64})$/i;
const TIMESTAMP_PATTERN = /^(0|[1-9][0-9]*)$/;

export function createWebhookSignature(
  secret: string,
  timestamp: string,
  rawBody: string,
): string {
  const digest = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`, "utf8")
    .digest("hex");
  return `sha256=${digest}`;
}

export function parseWebhookSignature(signature: string): Buffer | undefined {
  const match = SIGNATURE_PATTERN.exec(signature);
  if (!match?.[1]) return undefined;
  const bytes = Buffer.from(match[1], "hex");
  return bytes.length === 32 ? bytes : undefined;
}

export function verifyWebhookSignature(
  secret: string,
  timestamp: string,
  rawBody: string,
  signature: string,
): boolean {
  const received = parseWebhookSignature(signature);
  const expected = parseWebhookSignature(
    createWebhookSignature(secret, timestamp, rawBody),
  );
  if (!received || !expected || received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}

export function parseWebhookTimestamp(timestamp: string): number | undefined {
  if (!TIMESTAMP_PATTERN.test(timestamp)) return undefined;
  const value = Number(timestamp);
  return Number.isSafeInteger(value) ? value : undefined;
}

export function isWebhookTimestampFresh(
  timestamp: string,
  nowSeconds: number,
  maxAgeSeconds: number,
): boolean {
  const parsed = parseWebhookTimestamp(timestamp);
  return parsed !== undefined && Math.abs(nowSeconds - parsed) <= maxAgeSeconds;
}

