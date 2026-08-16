import { resolve } from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { loadConfig } from "../config.js";
import { createDatabase } from "./client.js";

const config = loadConfig();
const database = createDatabase(config.databaseUrl);

try {
  await migrate(database.db, {
    migrationsFolder: resolve(process.cwd(), "drizzle"),
  });
  console.info("Database migrations completed.");
} finally {
  await database.client.end({ timeout: 5 });
}
