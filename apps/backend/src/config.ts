import { config as loadDotEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { z } from "zod";

loadDotEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  BACKEND_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .refine(
      (value) => value.startsWith("postgres://") || value.startsWith("postgresql://"),
      "DATABASE_URL must be a PostgreSQL connection URL",
    ),
  REDIS_URL: z
    .string()
    .min(1, "REDIS_URL is required")
    .refine(
      (value) => value.startsWith("redis://") || value.startsWith("rediss://"),
      "REDIS_URL must be a Redis connection URL",
    ),
  FRONTEND_ORIGIN: z.url().default("http://localhost:5173"),
});

export type AppConfig = {
  nodeEnv: z.infer<typeof environmentSchema>["NODE_ENV"];
  backendPort: number;
  databaseUrl: string;
  redisUrl: string;
  frontendOrigin: string;
};

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = environmentSchema.safeParse(environment);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid configuration: ${details}`);
  }

  return {
    nodeEnv: result.data.NODE_ENV,
    backendPort: result.data.BACKEND_PORT,
    databaseUrl: result.data.DATABASE_URL,
    redisUrl: result.data.REDIS_URL,
    frontendOrigin: result.data.FRONTEND_ORIGIN,
  };
}
