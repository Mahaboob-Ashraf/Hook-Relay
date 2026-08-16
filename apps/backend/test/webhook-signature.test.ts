import { describe, expect, it } from "vitest";
import {
  createWebhookSignature,
  isWebhookTimestampFresh,
  parseWebhookSignature,
  verifyWebhookSignature,
} from "../src/signing/webhook-signature.js";

describe("webhook signatures", () => {
  const secret = "test-signing-secret";
  const timestamp = "1700000000";
  const rawBody = '{"orderId":123,"metadata":{"a":1,"b":2}}';

  it("is deterministic and uses the sha256 hex format", () => {
    const first = createWebhookSignature(secret, timestamp, rawBody);
    const second = createWebhookSignature(secret, timestamp, rawBody);

    expect(first).toBe(second);
    expect(first).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(parseWebhookSignature(first)).toHaveLength(32);
    expect(verifyWebhookSignature(secret, timestamp, rawBody, first)).toBe(true);
  });

  it("rejects a signature generated with a different secret", () => {
    const signature = createWebhookSignature("wrong-secret", timestamp, rawBody);
    expect(verifyWebhookSignature(secret, timestamp, rawBody, signature)).toBe(false);
  });

  it("rejects a changed raw body", () => {
    const signature = createWebhookSignature(secret, timestamp, rawBody);
    expect(
      verifyWebhookSignature(secret, timestamp, '{"orderId":999}', signature),
    ).toBe(false);
  });

  it("rejects a changed timestamp", () => {
    const signature = createWebhookSignature(secret, timestamp, rawBody);
    expect(verifyWebhookSignature(secret, "1700000001", rawBody, signature)).toBe(false);
  });

  it("rejects malformed signature formats safely", () => {
    expect(parseWebhookSignature("not-a-signature")).toBeUndefined();
    expect(parseWebhookSignature("sha256=abcd")).toBeUndefined();
    expect(verifyWebhookSignature(secret, timestamp, rawBody, "sha256=abcd")).toBe(false);
  });

  it("treats equivalent JSON with different raw bytes as different", () => {
    const compact = '{"a":1,"b":2}';
    const spaced = '{ "a": 1, "b": 2 }';
    const signature = createWebhookSignature(secret, timestamp, compact);

    expect(JSON.parse(compact)).toEqual(JSON.parse(spaced));
    expect(verifyWebhookSignature(secret, timestamp, spaced, signature)).toBe(false);
  });

  it("enforces the configured timestamp tolerance in both directions", () => {
    expect(isWebhookTimestampFresh("1000", 1300, 300)).toBe(true);
    expect(isWebhookTimestampFresh("999", 1300, 300)).toBe(false);
    expect(isWebhookTimestampFresh("1601", 1300, 300)).toBe(false);
    expect(isWebhookTimestampFresh("invalid", 1300, 300)).toBe(false);
  });
});

