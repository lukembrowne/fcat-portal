#!/usr/bin/env node
/**
 * Unattended audio compression backfill.
 *
 * Usage:
 *   AUDIO_COMPRESSION_ENABLED=true \
 *     ACTOR_EMAIL=ops@fcat-ecuador.org \
 *     node --import tsx scripts/compress-all-audio.mjs [--dry-run] [--deployments=1,2,3]
 *
 * Notes:
 *   - Imports the same core lib as the server action, proving the headless split
 *     in src/lib/audio-compression-core.ts works without a request context.
 *   - Enqueues one job per deployment, serially. The global-concurrency cap in
 *     core ensures only one runs at a time, so the rest queue as "pending".
 *   - Use --dry-run to encode + verify into /tmp without touching Drive/DB.
 */

import { db } from "../src/db/index.ts";
import { deployments, audioFiles, processingJobs } from "../src/db/schema.ts";
import {
  enqueueAudioCompressionJob,
} from "../src/lib/audio-compression-core.ts";
import { JOB_TYPES } from "../src/lib/job-types.ts";
import { and, eq, sql, inArray } from "drizzle-orm";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const explicitDeployments = args
  .find((a) => a.startsWith("--deployments="))
  ?.split("=")[1]
  ?.split(",")
  .map((x) => parseInt(x, 10))
  .filter((x) => !Number.isNaN(x));

const actorEmail = process.env.ACTOR_EMAIL;
if (!actorEmail) {
  console.error("ACTOR_EMAIL env var is required.");
  process.exit(1);
}

if (!dryRun && process.env.AUDIO_COMPRESSION_ENABLED !== "true") {
  console.error(
    "AUDIO_COMPRESSION_ENABLED=true is required for non-dry-run mode.",
  );
  process.exit(1);
}

async function pickDeployments() {
  if (explicitDeployments && explicitDeployments.length > 0) {
    return explicitDeployments;
  }
  // All deployments with at least one uncompressed WAV with a drive_file_id.
  const rows = await db
    .selectDistinct({ id: audioFiles.deploymentId })
    .from(audioFiles)
    .where(
      and(
        eq(audioFiles.compressed, false),
        sql`${audioFiles.driveFileId} IS NOT NULL`,
        sql`lower(${audioFiles.filename}) LIKE '%.wav'`,
      ),
    );
  return rows.map((r) => r.id);
}

async function waitForJob(jobId) {
  while (true) {
    const [j] = await db
      .select({ status: processingJobs.status, msg: processingJobs.statusMessage })
      .from(processingJobs)
      .where(eq(processingJobs.id, jobId));
    if (!j) return { status: "failed" };
    if (j.status === "completed" || j.status === "failed" || j.status === "cancelled") {
      return j;
    }
    process.stdout.write(`\r  job ${jobId}: ${j.status} — ${j.msg ?? ""}        `);
    await new Promise((r) => setTimeout(r, 5000));
  }
}

async function main() {
  // Sanity: refuse to start a second backfill if one is already in flight.
  const inFlight = await db
    .select({ id: processingJobs.id })
    .from(processingJobs)
    .where(
      and(
        inArray(processingJobs.jobType, [
          JOB_TYPES.AUDIO_COMPRESSION,
          JOB_TYPES.REVERT_AUDIO_COMPRESSION,
        ]),
        inArray(processingJobs.status, ["pending", "processing"]),
      ),
    );
  if (inFlight.length > 0) {
    console.error(
      `Refusing to start: ${inFlight.length} audio_compression job(s) already pending/processing.`,
    );
    process.exit(2);
  }

  const ids = await pickDeployments();
  console.log(
    `Found ${ids.length} deployment(s) with uncompressed WAVs. ` +
      `dryRun=${dryRun}. Actor=${actorEmail}.`,
  );

  for (const deploymentId of ids) {
    const [dep] = await db
      .select({ name: deployments.name })
      .from(deployments)
      .where(eq(deployments.id, deploymentId));
    console.log(`\n→ ${dep?.name ?? "(unknown)"} (#${deploymentId})`);
    const result = await enqueueAudioCompressionJob({
      deploymentId,
      actorEmail,
      dryRun,
    });
    if (!result.success) {
      console.log(`  refused: ${result.error}`);
      continue;
    }
    const final = await waitForJob(result.data.jobId);
    console.log(`\n  done (${final.status}): ${final.msg ?? ""}`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
