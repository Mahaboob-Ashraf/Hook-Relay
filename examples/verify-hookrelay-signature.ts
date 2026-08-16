import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_AGE_SECONDS = 300;

export function verifyHookRelaySignature(
  secret: string,
  timestamp: string,
  rawBody: string,
  signature: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (!/^(0|[1-9][0-9]*)$/.test(timestamp)) return false;
  const timestampSeconds = Number(timestamp);
  if (
    !Number.isSafeInteger(timestampSeconds) ||
    Math.abs(nowSeconds - timestampSeconds) > MAX_AGE_SECONDS
  ) {
    return false;
  }

  const match = /^sha256=([0-9a-f]{64})$/i.exec(signature);
  if (!match?.[1]) return false;

  // `rawBody` must be the exact bytes/string received over HTTP.
  const expectedHex = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`, "utf8")
    .digest("hex");
  const expected = Buffer.from(expectedHex, "hex");
  const received = Buffer.from(match[1], "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

