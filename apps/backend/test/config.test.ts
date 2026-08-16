import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

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

