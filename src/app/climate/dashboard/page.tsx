import { requirePermission } from "@/lib/auth";
import { db } from "@/db";
import { climateReadings } from "@/db/schema";
import { sql } from "drizzle-orm";
import { DashboardShell } from "./dashboard-shell";

export default async function ClimateDashboardPage() {
  await requirePermission("climate", "viewer");

  // Check if there's any data to display
  const countResult = db
    .select({ count: sql<number>`COUNT(*)` })
    .from(climateReadings)
    .all();

  const hasData = (countResult[0]?.count ?? 0) > 0;

  return <DashboardShell hasData={hasData} />;
}
