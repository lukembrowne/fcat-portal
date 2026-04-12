/**
 * Import historical researcher applications from Airtable CSV export.
 *
 * Usage:
 *   npx tsx scripts/import-airtable-research-applications.ts \
 *     --csv-applications "data/airtable-import/Researcher Applications-Grid view.csv" \
 *     --csv-reports "data/airtable-import/Reports-Grid view.csv" \
 *     [--dry-run] [--yes]
 *
 * Steps before running:
 *   1. Export both grid views from Airtable as CSV
 *   2. Copy CSVs to data/airtable-import/
 *   3. Run with --dry-run first
 *   4. Review the log, then run for real
 */

import Database from "better-sqlite3";
import { parse } from "csv-parse/sync";
import { readFileSync, mkdirSync, appendFileSync } from "fs";
import path from "path";
import readline from "readline";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const dbPath = process.env.DB_PATH || "data/portal.db";
const fullDbPath = path.isAbsolute(dbPath)
  ? dbPath
  : path.join(process.cwd(), dbPath);

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const autoYes = args.includes("--yes");
const csvAppsPath =
  args[args.indexOf("--csv-applications") + 1] ??
  "data/airtable-import/Researcher Applications-Grid view.csv";
const csvReportsPath =
  args[args.indexOf("--csv-reports") + 1] ??
  "data/airtable-import/Reports-Grid view.csv";

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const LOG_DIR = path.join(process.cwd(), "data", "imports");
mkdirSync(LOG_DIR, { recursive: true });
const timestamp = new Date().toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "");
const LOG_FILE = path.join(LOG_DIR, `airtable-${timestamp}.log`);

function logLine(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  appendFileSync(LOG_FILE, line + "\n");
}

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

function mapStatus(
  airtableStatus: string | undefined
): "submitted" | "under_review" | "accepted" | "rejected" | "revisions_requested" {
  const s = (airtableStatus ?? "").toLowerCase().trim();
  if (s.includes("accept")) return "accepted";
  if (s.includes("reject") || s.includes("denied")) return "rejected";
  if (s.includes("review") || s.includes("pending")) return "under_review";
  if (s.includes("revision")) return "revisions_requested";
  return "submitted";
}

// ---------------------------------------------------------------------------
// Date parsing — Airtable exports dates like "1/24/2025 7:14pm"
// ---------------------------------------------------------------------------

function parseAirtableDate(str: string): number {
  if (!str) return Math.floor(Date.now() / 1000);

  // Try native parse first
  const native = new Date(str).getTime();
  if (!isNaN(native)) return Math.floor(native / 1000);

  // Parse "M/D/YYYY H:MMam/pm" format
  const match = str.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(am|pm)?$/i
  );
  if (match) {
    let [, month, day, year, hours, minutes, ampm] = match;
    let h = parseInt(hours, 10);
    if (ampm?.toLowerCase() === "pm" && h < 12) h += 12;
    if (ampm?.toLowerCase() === "am" && h === 12) h = 0;
    const d = new Date(
      parseInt(year, 10),
      parseInt(month, 10) - 1,
      parseInt(day, 10),
      h,
      parseInt(minutes, 10)
    );
    if (!isNaN(d.getTime())) return Math.floor(d.getTime() / 1000);
  }

  // Fallback
  return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  logLine(`Import started. dry-run=${dryRun}`);
  logLine(`Applications CSV: ${csvAppsPath}`);
  logLine(`Reports CSV: ${csvReportsPath}`);
  logLine(`Database: ${fullDbPath}`);

  // Parse CSVs
  const appsCsv = readFileSync(csvAppsPath, "utf-8").replace(/^\uFEFF/, ""); // strip BOM
  const appRows = parse(appsCsv, {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    trim: true,
  }) as Record<string, string>[];

  logLine(`Parsed ${appRows.length} application rows`);

  let reportRows: Record<string, string>[] = [];
  try {
    const reportsCsv = readFileSync(csvReportsPath, "utf-8").replace(/^\uFEFF/, "");
    reportRows = parse(reportsCsv, {
      columns: true,
      skip_empty_lines: true,
      relax_quotes: true,
      trim: true,
    }) as Record<string, string>[];
    logLine(`Parsed ${reportRows.length} report rows`);
  } catch (err) {
    logLine(`WARNING: Could not parse reports CSV: ${err}`);
  }

  if (!autoYes && !dryRun) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) =>
      rl.question(`Import ${appRows.length} applications? (y/n): `, resolve)
    );
    rl.close();
    if (answer.toLowerCase() !== "y") {
      logLine("Aborted by user.");
      return;
    }
  }

  const db = new Database(fullDbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  // Check if this external_id already exists (partial unique index doesn't support ON CONFLICT)
  const findByExternalId = db.prepare(
    `SELECT id FROM research_applications WHERE external_id = ?`
  );

  const insertApp = db.prepare(`
    INSERT INTO research_applications (
      external_id, reference_code, status, project_title, pi_full_name,
      pi_email, pi_phone, pi_institution, collaborators,
      project_start_date, project_end_date, project_goals, methods,
      samples_details, genetic_resources, needs_fcat_assistance,
      facilities_needs, permanent_equipment, personnel_collaboration,
      community_engagement, data_sharing, code_of_conduct_agreed,
      guidelines_agreed, permits_status, primary_reviewer_email,
      decision_notes, final_report_due_date, created_at, updated_at
    ) VALUES (
      @externalId, @referenceCode, @status, @projectTitle, @piFullName,
      @piEmail, @piPhone, @piInstitution, @collaborators,
      @projectStartDate, @projectEndDate, @projectGoals, @methods,
      @samplesDetails, @geneticResources, @needsFcatAssistance,
      @facilitiesNeeds, @permanentEquipment, @personnelCollaboration,
      @communityEngagement, @dataSharing, @codeOfConductAgreed,
      @guidelinesAgreed, @permitsStatus, @primaryReviewerEmail,
      @decisionNotes, @finalReportDueDate, @createdAt, @updatedAt
    )
  `);

  const updateApp = db.prepare(`
    UPDATE research_applications SET status = @status, updated_at = @updatedAt
    WHERE external_id = @externalId
  `);

  const insertRef = db.prepare(`
    INSERT INTO research_application_references (application_id, ordinal, name, email, phone)
    VALUES (?, ?, ?, ?, ?)
  `);

  const insertReport = db.prepare(`
    INSERT INTO research_reports (application_id, summary, submitted_at)
    VALUES (?, ?, ?)
  `);

  let imported = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;

  // Build a map of project title → report rows for matching
  const reportMap = new Map<string, Record<string, string>[]>();
  for (const r of reportRows) {
    const title = (r["Project Title"] ?? r["Link to Researcher Applications"] ?? "").trim();
    if (!title) continue;
    const existing = reportMap.get(title);
    if (existing) existing.push(r);
    else reportMap.set(title, [r]);
  }

  for (let i = 0; i < appRows.length; i++) {
    const row = appRows[i];
    try {
      const projectTitle = (row["Project Title"] ?? "").trim();
      if (!projectTitle) {
        logLine(`SKIP row ${i + 1}: no project title`);
        skipped++;
        continue;
      }

      const piEmail = (row["Email Address"] ?? "").trim().toLowerCase();
      if (!piEmail) {
        logLine(`SKIP row ${i + 1}: no email for "${projectTitle}"`);
        skipped++;
        continue;
      }

      // Generate a stable external ID from the CSV (no Airtable record ID available)
      const externalId = `airtable-${Buffer.from(`${projectTitle}|${piEmail}`).toString("base64url").slice(0, 40)}`;

      const needsFcat =
        (row["Do you require the assistance of FCAT in any way for the proposed research?"] ?? "")
          .toLowerCase()
          .includes("yes")
          ? 1
          : 0;

      const conductAgreed =
        (row["FCAT Code of Conduct Agreement"] ?? "").toLowerCase().includes("agree")
          ? 1
          : 0;
      const guidelinesAgreed =
        (row["FCAT Researcher Guidelines and Expectations Document"] ?? "")
          .toLowerCase()
          .includes("agree")
          ? 1
          : 0;

      const permitsObtained = row["Research Permits (if pending or obtained)"] ?? "";
      const permitsNotObtained = row["Research Permits (if not pending or obtained)"] ?? "";
      const permitsStatus = [permitsObtained, permitsNotObtained].filter(Boolean).join("\n").trim() || null;

      const createdStr = row["Created"] ?? "";
      const createdAt = parseAirtableDate(createdStr);

      const status = mapStatus(row["Application status"]);

      if (dryRun) {
        logLine(`DRY-RUN row ${i + 1}: "${projectTitle}" by ${piEmail} → ${status}`);
        imported++;
        continue;
      }

      // Check if already imported
      const existing = findByExternalId.get(externalId) as { id: number } | undefined;
      if (existing) {
        updateApp.run({ externalId, status, updatedAt: createdAt });
        updated++;
        logLine(`UPDATED row ${i + 1}: "${projectTitle}"`);
        continue;
      }

      const result = insertApp.run({
        externalId,
        referenceCode: null, // will be set after insert
        status,
        projectTitle,
        piFullName: (row["Full name"] ?? "").trim(),
        piEmail,
        piPhone: (row["Cell-phone number"] ?? "").trim() || null,
        piInstitution: (row["Institution"] ?? "").trim() || null,
        collaborators: (row["Collaborators"] ?? "").trim() || null,
        projectStartDate: (row["Project Start Date"] ?? "").trim() || null,
        projectEndDate: (row["Project End Date"] ?? "").trim() || null,
        projectGoals: (row["Project Goals and Justification"] ?? "").trim() || null,
        methods: (row["Detailed Methods"] ?? "").trim() || null,
        samplesDetails: (row["Sample Collection, Storage, Movement, and Export Details"] ?? "").trim() || null,
        geneticResources: (row["Genetic Resources Details"] ?? "").trim() || null,
        needsFcatAssistance: needsFcat,
        facilitiesNeeds: (row["Use of FCAT Facilities and Resources"] ?? "").trim() || null,
        permanentEquipment: (row["Installation of Permanent Equipment or Infrastructure"] ?? "").trim() || null,
        personnelCollaboration: (row["FCAT Personnel and Collaboration"] ?? "").trim() || null,
        communityEngagement: (row["Community Engagement and Outreach"] ?? "").trim() || null,
        dataSharing: (row["Data Sharing and Dissemination"] ?? "").trim() || null,
        codeOfConductAgreed: conductAgreed,
        guidelinesAgreed: guidelinesAgreed,
        permitsStatus,
        primaryReviewerEmail: (row["Primary FCAT Reviewer"] ?? "").trim() || null,
        decisionNotes: (row["Official decision"] ?? "").trim() || null,
        finalReportDueDate: (row["Final Report Due Date"] ?? "").trim() || null,
        createdAt,
        updatedAt: createdAt,
      });

      const appId = Number(result.lastInsertRowid);

      // Set reference code
      const year = new Date(createdAt * 1000).getFullYear();
      const refCode = `FCAT-${year}-${String(appId).padStart(5, "0")}`;
      db.prepare("UPDATE research_applications SET reference_code = ? WHERE id = ?").run(refCode, appId);

      // Insert references
      for (let refIdx = 1; refIdx <= 3; refIdx++) {
        const name = (row[`Reference #${refIdx} - Full Name`] ?? "").trim();
        if (name) {
          insertRef.run(
            appId,
            refIdx,
            name,
            (row[`Reference #${refIdx} - Email`] ?? "").trim() || null,
            (row[`Reference #${refIdx} - Phone`] ?? "").trim() || null
          );
        }
      }

      // Match reports by title
      const matchedReports = reportMap.get(projectTitle);
      if (matchedReports) {
        for (const report of matchedReports) {
          const reportStatus = (report["Final Report Status"] ?? "").trim();
          if (reportStatus.toLowerCase().includes("submitted")) {
            insertReport.run(appId, null, createdAt);
            logLine(`  → Linked report for "${projectTitle}"`);
          }
        }
      }

      imported++;
      logLine(`IMPORTED row ${i + 1}: [${refCode}] "${projectTitle}"`);
    } catch (err) {
      errors++;
      logLine(`ERROR row ${i + 1}: ${err}`);
    }
  }

  db.close();

  logLine(`\nDone. imported=${imported} updated=${updated} skipped=${skipped} errors=${errors}`);
  logLine(`Log: ${LOG_FILE}`);
}

main().catch((err) => {
  logLine(`FATAL: ${err}`);
  process.exit(1);
});
