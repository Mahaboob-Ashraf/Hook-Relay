import { afterEach, describe, expect, it } from "vitest";
import {
  createDemoReceiver,
  type DemoReceiverResources,
} from "../src/demo-receiver/app.js";
import { createWebhookSignature } from "../src/signing/webhook-signature.js";

describe("demo receiver", () => {
  const secret = "demo-test-secret";
  const now = 1_700_000_000;
  const timestamp = now.toString();
  const eventId = "00000000-0000-4000-8000-000000000001";
  const rawBody = '{ "orderId": 123, "metadata": {"a":1} }';
  let receiver: DemoReceiverResources | undefined;

  afterEach(async () => {
    await receiver?.app.close();
    receiver = undefined;
  });

  function createReceiver() {
    receiver = createDemoReceiver({
      secret,
      maxAgeSeconds: 300,
      nowSeconds: () => now,
    });
    return receiver;
  }

  function signedHeaders(
    body = rawBody,
    signingSecret = secret,
    signedTimestamp = timestamp,
  ) {
    return {
      "content-type": "application/json",
      "x-hookrelay-event-id": eventId,
      "x-hookrelay-event-type": "order.created",
      "x-hookrelay-timestamp": signedTimestamp,
      "x-hookrelay-signature": createWebhookSignature(
        signingSecret,
        signedTimestamp,
        body,
      ),
    };
  }

  it("accepts a correctly signed exact raw body", async () => {
    const demo = createReceiver();
    const response = await demo.app.inject({
      method: "POST",
      url: "/demo/webhook?scenario=valid&fail_first=0",
      headers: signedHeaders(),
      payload: rawBody,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      scenario: "valid",
      receivedAttempt: 1,
      eventId,
      eventType: "order.created",
      accepted: true,
    });
    expect(demo.getScenarioState("valid")?.lastRequest.rawBody).toBe(rawBody);
  });

  it("rejects a request signed with the wrong secret", async () => {
    const demo = createReceiver();
    const response = await demo.app.inject({
      method: "POST",
      url: "/demo/webhook?scenario=wrong-secret&fail_first=0",
      headers: signedHeaders(rawBody, "wrong-secret"),
      payload: rawBody,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("invalid_signature");
    expect(demo.getScenarioState("wrong-secret")).toBeUndefined();
  });

  it("rejects a body changed after signing", async () => {
    const demo = createReceiver();
    const response = await demo.app.inject({
      method: "POST",
      url: "/demo/webhook?scenario=tampered&fail_first=0",
      headers: signedHeaders(rawBody),
      payload: '{"orderId":999}',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("invalid_signature");
  });

  it("rejects a correctly signed stale timestamp", async () => {
    const demo = createReceiver();
    const staleTimestamp = (now - 301).toString();
    const response = await demo.app.inject({
      method: "POST",
      url: "/demo/webhook?scenario=stale&fail_first=0",
      headers: signedHeaders(rawBody, secret, staleTimestamp),
      payload: rawBody,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("stale_timestamp");
  });

  it("returns 400 when required metadata headers are missing", async () => {
    const demo = createReceiver();
    const response = await demo.app.inject({
      method: "POST",
      url: "/demo/webhook?scenario=missing&fail_first=0",
      headers: { "content-type": "application/json" },
      payload: rawBody,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_request");
  });

  it("returns 500, 500, then 200 for fail_first=2", async () => {
    const demo = createReceiver();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await demo.app.inject({
        method: "POST",
        url: "/demo/webhook?scenario=controlled&fail_first=2",
        headers: signedHeaders(),
        payload: rawBody,
      });
      statuses.push(response.statusCode);
      expect(response.json().receivedAttempt).toBe(attempt + 1);
    }

    expect(statuses).toEqual([500, 500, 200]);
    expect(demo.getScenarioState("controlled")).toMatchObject({
      validRequestCount: 3,
      responseStatuses: [500, 500, 200],
    });
  });

  it("does not let an invalid signature consume a controlled failure", async () => {
    const demo = createReceiver();
    const invalid = await demo.app.inject({
      method: "POST",
      url: "/demo/webhook?scenario=counter&fail_first=1",
      headers: signedHeaders(rawBody, "wrong-secret"),
      payload: rawBody,
    });
    const firstValid = await demo.app.inject({
      method: "POST",
      url: "/demo/webhook?scenario=counter&fail_first=1",
      headers: signedHeaders(),
      payload: rawBody,
    });
    const secondValid = await demo.app.inject({
      method: "POST",
      url: "/demo/webhook?scenario=counter&fail_first=1",
      headers: signedHeaders(),
      payload: rawBody,
    });

    expect(invalid.statusCode).toBe(401);
    expect(firstValid.statusCode).toBe(500);
    expect(firstValid.json().receivedAttempt).toBe(1);
    expect(secondValid.statusCode).toBe(200);
    expect(secondValid.json().receivedAttempt).toBe(2);
  });

  it("resets one scenario without restarting", async () => {
    const demo = createReceiver();
    await demo.app.inject({
      method: "POST",
      url: "/demo/webhook?scenario=reset-me&fail_first=0",
      headers: signedHeaders(),
      payload: rawBody,
    });
    const reset = await demo.app.inject({
      method: "POST",
      url: "/demo/reset",
      headers: { "content-type": "application/json" },
      payload: '{"scenario":"reset-me"}',
    });

    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toEqual({ scenario: "reset-me", reset: true });
    expect(demo.getScenarioState("reset-me")).toBeUndefined();
  });
});
