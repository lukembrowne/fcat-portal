import { db } from "@/db";
import { appState } from "@/db/schema";
import { eq, sql } from "drizzle-orm";

/**
 * Generic key/value store for cross-module flags and timestamps that don't
 * belong on any single domain table (e.g. "last drive sync for camera trap").
 *
 * Keys should be namespaced by module — e.g. `camera_trap_drive_last_sync_at`.
 */

/** Read the timestamp (Date) for a given key, or null if not set. */
export async function getAppStateTimestamp(key: string): Promise<Date | null> {
  const [row] = await db
    .select({ updatedAt: appState.updatedAt })
    .from(appState)
    .where(eq(appState.key, key))
    .limit(1);
  return row?.updatedAt ?? null;
}

/** Touch a key, setting `updated_at = now`. Used for "last X happened" markers. */
export async function touchAppState(key: string, value?: string): Promise<void> {
  await db
    .insert(appState)
    .values({ key, value: value ?? null })
    .onConflictDoUpdate({
      target: appState.key,
      set: { value: value ?? null, updatedAt: sql`(unixepoch())` },
    });
}
