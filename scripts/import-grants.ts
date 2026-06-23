/**
 * One-time import of grants + funders from the legacy Google Sheet export (.xlsx).
 *
 * Usage (ALWAYS in-container — host runs corrupt data/portal.db on macOS bind mounts):
 *   docker compose exec portal npx tsx scripts/import-grants.ts \
 *     --file "data/imports/FCAT Grant and Funder Database.xlsx" [--wipe] [--dry-run]
 *
 * Steps:
 *   1. Copy the .xlsx into data/imports/ (data/ is mounted into the container)
 *   2. Run with --dry-run first and review data/imports/grants-<ts>.log
 *   3. Run with --wipe for a clean load (truncates grants + funders first)
 *
 * Sheets consumed: "Funders" (parent) then "Grants" (child). The optional
 * "Form Responses 6" sheet is ignored — it duplicates rows already in Grants.
 */

import Database from "better-sqlite3";
import * as XLSX from "xlsx";
import { mkdirSync, appendFileSync, existsSync } from "fs";
import path from "path";
import { normalizeFunderName } from "../src/lib/grants/normalize";
import {
  parseDateToSeconds,
  parseAmount,
  parseDays,
  mapStatus,
  mapPriority,
} from "../src/lib/grants/coerce";

// ---------------------------------------------------------------------------
// Config + CLI
// ---------------------------------------------------------------------------

const dbPath = process.env.DB_PATH || "data/portal.db";
const fullDbPath = path.isAbsolute(dbPath) ? dbPath : path.join(process.cwd(), dbPath);

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const wipe = args.includes("--wipe");
const filePath =
  args[args.indexOf("--file") + 1] && args.indexOf("--file") !== -1
    ? args[args.indexOf("--file") + 1]
    : "data/imports/FCAT Grant and Funder Database.xlsx";

const LOG_DIR = path.join(process.cwd(), "data", "imports");
mkdirSync(LOG_DIR, { recursive: true });
const ts = new Date().toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "");
const LOG_FILE = path.join(LOG_DIR, `grants-${ts}.log`);

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  appendFileSync(LOG_FILE, line + "\n");
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  log(`Import started. dry-run=${dryRun} wipe=${wipe}`);
  log(`File: ${filePath}`);
  log(`Database: ${fullDbPath}`);

  if (!existsSync(filePath)) {
    log(`ERROR: file not found: ${filePath}`);
    process.exit(1);
  }

  const wb = XLSX.readFile(filePath, { cellDates: true });
  const funderRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(
    wb.Sheets["Funders"],
    { defval: null }
  );
  const grantRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(
    wb.Sheets["Grants"],
    { defval: null }
  );
  log(`Read ${funderRows.length} funder rows, ${grantRows.length} grant rows`);

  const db = new Database(fullDbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const stats = {
    fundersInserted: 0,
    funderCollisions: 0,
    grantsInserted: 0,
    grantsLinked: 0,
    grantsUnlinked: 0,
  };

  // name_normalized → funder id, for grant linking
  const funderByName = new Map<string, number>();

  const insertFunder = db.prepare(`
    INSERT INTO funders
      (name, name_normalized, website, priority, funder_type, focus_areas,
       relationship_manager, relationship_status, next_steps, next_step_due,
       contact_name, contact_email, funding_history, description, notes,
       irs990_link, guidestar_link, foundation_directory_link)
    VALUES
      (@name, @name_normalized, @website, @priority, @funder_type, @focus_areas,
       @relationship_manager, @relationship_status, @next_steps, @next_step_due,
       @contact_name, @contact_email, @funding_history, @description, @notes,
       @irs990_link, @guidestar_link, @foundation_directory_link)
  `);

  const insertGrant = db.prepare(`
    INSERT INTO grants
      (funder_id, funder_name_raw, name, website, status, amount_requested,
       amount_awarded, due_date, notify_before_days, check_rfp_date, notes,
       folder_link, budget_link, proposal_link)
    VALUES
      (@funder_id, @funder_name_raw, @name, @website, @status, @amount_requested,
       @amount_awarded, @due_date, @notify_before_days, @check_rfp_date, @notes,
       @folder_link, @budget_link, @proposal_link)
  `);

  const run = db.transaction(() => {
    if (wipe) {
      db.exec("DELETE FROM grants");
      db.exec("DELETE FROM funders");
      log("Wiped grants + funders");
    }

    // --- Funders (parents) ---
    for (const r of funderRows) {
      const name = str(r["Funder Name"]);
      if (!name) continue;
      const norm = normalizeFunderName(name);
      if (funderByName.has(norm)) {
        stats.funderCollisions++;
        log(`WARN funder name collision (normalized="${norm}"): "${name}" — keeping first, skipping`);
        continue;
      }
      const info = insertFunder.run({
        name,
        name_normalized: norm,
        website: str(r["Website"]),
        priority: mapPriority(r["Priority"]),
        funder_type: str(r["Funder Type"]),
        focus_areas: str(r["Focus Areas"]),
        relationship_manager: str(r["Relationship Manager"]),
        relationship_status: str(r["Relationship Status"]),
        next_steps: str(r["Next Steps"]),
        next_step_due: parseDateToSeconds(r["Next Step Due"]),
        contact_name: str(r["Contact Name"]),
        contact_email: str(r["Contact Email"]),
        funding_history: str(r["Funding History"]),
        description: str(r["Description"]),
        notes: str(r["Notes"]),
        irs990_link: str(r["IRS 990"]),
        guidestar_link: str(r["GuideStar"]),
        foundation_directory_link: str(r["Foundation Directory"]),
      });
      funderByName.set(norm, Number(info.lastInsertRowid));
      stats.fundersInserted++;
    }

    // --- Grants (children) ---
    for (const r of grantRows) {
      const name = str(r["Grant Name"]);
      if (!name) continue;
      const funderName = str(r["Funder"]);
      let funderId: number | null = null;
      let funderNameRaw: string | null = null;
      if (funderName) {
        const norm = normalizeFunderName(funderName);
        funderId = funderByName.get(norm) ?? null;
        if (funderId) stats.grantsLinked++;
        else {
          funderNameRaw = funderName;
          stats.grantsUnlinked++;
        }
      }
      insertGrant.run({
        funder_id: funderId,
        funder_name_raw: funderNameRaw,
        name,
        website: str(r["Website"]),
        status: mapStatus(r["Status"]),
        amount_requested: parseAmount(r["Amount Requested"]),
        amount_awarded: parseAmount(r["Amount Awarded"]), // column absent → null
        due_date: parseDateToSeconds(r["Due Date"]),
        notify_before_days: parseDays(r["Notify Before (Days)"]),
        check_rfp_date: parseDateToSeconds(r["Check RFP Date"]),
        notes: str(r["Notes"]),
        folder_link: str(r["Folder Link"]),
        budget_link: str(r["Budget Link"]),
        proposal_link: str(r["Proposal Link"]),
      });
      stats.grantsInserted++;
    }

    if (dryRun) {
      throw new Error("__DRY_RUN_ROLLBACK__");
    }
  });

  try {
    run();
  } catch (err) {
    if (err instanceof Error && err.message === "__DRY_RUN_ROLLBACK__") {
      log("DRY RUN — transaction rolled back, no rows written");
    } else {
      throw err;
    }
  }

  log(
    `Done. funders=${stats.fundersInserted} (collisions=${stats.funderCollisions}) ` +
      `grants=${stats.grantsInserted} linked=${stats.grantsLinked} unlinked=${stats.grantsUnlinked}`
  );
  db.close();
}

main();
