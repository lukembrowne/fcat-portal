/**
 * BioChoco monthly data-quality review — snapshot + checks engine.
 *
 * Forces a LIVE Google Drive re-count of every deployment, gathers the merged
 * schedule ⨯ ODK ⨯ Drive ⨯ DB snapshot, runs the rule-based checks, and writes
 * a JSON evidence file. The `biochoco-data-review` skill runs this, then reasons
 * over the JSON to author the Spanish report.
 *
 * MUST run inside the Docker container (it opens data/portal.db via the app's DB
 * singleton and needs Drive/Sheets/ODK credentials). Running it bare on the host
 * while the container is up can corrupt SQLite — see CLAUDE.md / memory.
 *
 * Usage:
 *   docker compose exec -T portal npx tsx scripts/biochoco-review-snapshot.ts
 *   docker compose exec -T portal npx tsx scripts/biochoco-review-snapshot.ts --out data/reviews/snapshot-2026-06.json
 *   docker compose exec -T portal npx tsx scripts/biochoco-review-snapshot.ts --no-recount   # dev: skip the slow live re-count
 *   docker compose exec -T portal npx tsx scripts/biochoco-review-snapshot.ts --today 2026-06-16
 *
 * Plan: docs/plans/2026-06-16-feat-biochoco-data-quality-review-skill-plan.md
 */

import fs from "fs";
import path from "path";
import { buildReviewSnapshot, ecuadorToday } from "@/lib/biochoco-review-core";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const noRecount = process.argv.includes("--no-recount");
  const today = arg("--today") ?? ecuadorToday();
  const yearMonth = today.slice(0, 7);
  const outPath =
    arg("--out") ?? path.join("data", "reviews", `snapshot-${yearMonth}.json`);

  const startedAt = Date.now();
  console.error(`[biochoco-review] today=${today} out=${outPath} recount=${!noRecount}`);
  if (!noRecount) console.error("[biochoco-review] live Drive re-count starting (slow)…");

  const snapshot = await buildReviewSnapshot({
    today,
    recount: !noRecount,
    onRecountProgress: (done, total, name) => {
      if (done % 10 === 0 || done === total)
        console.error(`[biochoco-review] re-count ${done}/${total} (${name})`);
    },
  });

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2));

  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  const s = snapshot.summary;
  console.error(
    `[biochoco-review] done in ${elapsed}s — ` +
      `🔴 ${s.error}  🟡 ${s.warn}  🔵 ${s.info}  ` +
      `(${snapshot.totals.withFindings}/${snapshot.totals.deployments} deployments with findings, ` +
      `${snapshot.totals.driveRecountFailures} re-count failures)`
  );
  console.error("[biochoco-review] by check: " + JSON.stringify(s.byCheck));
  // stdout = the snapshot path, for the skill to pick up.
  console.log(outPath);
}

main().catch((err) => {
  console.error("[biochoco-review] FAILED:", err);
  process.exit(1);
});
