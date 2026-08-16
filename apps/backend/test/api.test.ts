import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/api/app.js";

const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("health routes", () => {
  it("reports liveness without calling dependencies", async () => {
    let dependencyCalls = 0;
    const check = async () => {
      dependencyCalls += 1;
      throw new Error("dependency unavailable");
    };
    const app = buildApp({ dependencyChecks: { postgres: check, redis: check } });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/health/live" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "alive" });
    expect(dependencyCalls).toBe(0);
  });

  it("reports ready when both dependencies are available", async () => {
    const app = buildApp({
      dependencyChecks: {
        postgres: async () => undefined,
        redis: async () => undefined,
      },
    });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ready",
      dependencies: {
        postgres: { status: "up" },
        redis: { status: "up" },
      },
    });
  });

  it("returns 503 and identifies an unavailable dependency", async () => {
    const app = buildApp({
      dependencyChecks: {
        postgres: async () => undefined,
        redis: async () => {
          throw new Error("Redis unavailable");
        },
      },
    });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: "not_ready",
      dependencies: {
        postgres: { status: "up" },
        redis: { status: "down", error: "Redis unavailable" },
      },
    });
  });
});

