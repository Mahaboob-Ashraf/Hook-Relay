import { sql } from "drizzle-orm";
import type { DatabaseResources } from "./client.js";

export async function checkDatabase(resources: DatabaseResources): Promise<void> {
  await resources.db.execute(sql`select 1`);
}

