/**
 * Trigger the BioChoco data-quality review snapshot from INSIDE the container,
 * printing the snapshot JSON to stdout. The `biochoco-data-review` skill runs
 * this in production via:
 *
 *   ssh digitalocean "cd /root/opt/fcat-portal && \
 *     docker compose exec -T portal node scripts/run-biochoco-review.mjs"
 *
 * Why a plain .mjs (not the tsx script): the production standalone image prunes
 * devDependencies, so `npx tsx` isn't reliable there (see CLAUDE.md gotcha). This
 * uses only `node` + global fetch, and the heavy logic lives in the already-built
 * API route (`/api/cron/biochoco-review`). CRON_SECRET stays in the container env
 * — it is never passed on the command line or exposed.
 *
 * Flags: --no-recount (use cached counts, fast — default is a live re-count),
 *        --today YYYY-MM-DD (override the reference date).
 */

const secret = process.env.CRON_SECRET;
if (!secret) {
  console.error("[run-biochoco-review] CRON_SECRET not set in environment");
  process.exit(2);
}

const port = process.env.PORT || "3000";
const recount = !process.argv.includes("--no-recount");
const todayIdx = process.argv.indexOf("--today");
const today = todayIdx >= 0 ? process.argv[todayIdx + 1] : undefined;

const params = new URLSearchParams();
if (!recount) params.set("recount", "false");
if (today) params.set("today", today);
const qs = params.toString();
const url = `http://localhost:${port}/api/cron/biochoco-review${qs ? `?${qs}` : ""}`;

console.error(`[run-biochoco-review] POST ${url} (recount=${recount})`);

try {
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}` },
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`[run-biochoco-review] HTTP ${res.status}: ${text.slice(0, 500)}`);
    process.exit(1);
  }
  // stdout = the snapshot JSON, for the skill to consume.
  process.stdout.write(text);
} catch (err) {
  console.error("[run-biochoco-review] request failed:", err);
  process.exit(1);
}
