import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";

export type DatabaseResources = {
  db: PostgresJsDatabase;
  client: Sql;
};

export type AppDatabase = DatabaseResources["db"];

export function createDatabase(databaseUrl: string): DatabaseResources {
  const client = postgres(databaseUrl, {
    max: 10,
    connect_timeout: 5,
    idle_timeout: 20,
  });

  return {
    client,
    db: drizzle(client),
  };
}
