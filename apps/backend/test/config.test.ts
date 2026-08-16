import { describe, expect, it } from "vitest";
import { loadConfig, loadDemoReceiverConfig } from "../src/config.js";

const validEnvironment = {
  NODE_ENV: "test",
  BACKEND_PORT: "3100",
  DATABASE_URL: "postgresql://user:password@localhost:5432/hookrelay",
  REDIS_URL: "redis://localhost:6379",
  FRONTEND_ORIGIN: "http://localhost:5173",
};

describe("loadConfig", () => {
  it("validates and transforms configuration", () => {
    expect(loadConfig(validEnvironment)).toMatchObject({
      nodeEnv: "test",
      backendPort: 3100,
      databaseUrl: validEnvironment.DATABASE_URL,
      redisUrl: validEnvironment.REDIS_URL,
    });
  });

  it("fails fast with useful field names", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL.*REDIS_URL/);
  });
});

describe("loadDemoReceiverConfig", () => {
  it("provides safe local defaults", () => {
    expect(loadDemoReceiverConfig({})).toEqual({
      port: 3400,
      secret: "local-demo-secret",
      maxAgeSeconds: 300,
    });
  });

  it("validates receiver configuration", () => {
    expect(() =>
      loadDemoReceiverConfig({
        DEMO_RECEIVER_PORT: "0",
        DEMO_RECEIVER_SECRET: "",
        DEMO_RECEIVER_MAX_AGE_SECONDS: "0",
      }),
    ).toThrow(/DEMO_RECEIVER_PORT.*DEMO_RECEIVER_SECRET.*DEMO_RECEIVER_MAX_AGE_SECONDS/);
  });
});

