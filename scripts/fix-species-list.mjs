/**
 * Fix species list issues found during review.
 *
 * Changes:
 * 1. Potos flavos → Potos flavus (typo fix)
 * 2. Leopardus wiedii type: system → mammal
 * 3. Sciuridae sp. → merge into Sciurus sp. (family→genus)
 * 4. Procyon sp. → merge into Procyon cancrivorus (redundant genus)
 * 5. Dasyprocta punctata spanish_name: Guanta → Guatusa
 * 6. Canis familiaris → Canis lupus familiaris
 *
 * Usage: node scripts/fix-species-list.mjs
 *   --dry-run   Show what would change without modifying the DB (default)
 *   --apply      Actually apply the changes
 */

import Database from "better-sqlite3";
import path from "path";

const dryRun = !process.argv.includes("--apply");

const dbPath = process.env.DB_PATH || "data/portal.db";
const fullPath = path.isAbsolute(dbPath)
  ? dbPath
  : path.join(process.cwd(), dbPath);

const db = new Database(fullPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

if (dryRun) {
  console.log("=== DRY RUN (pass --apply to execute) ===\n");
}

function countIdentifications(scientificName) {
  const row = db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM biochoco_identifications WHERE species = ?) AS asSpecies,
        (SELECT COUNT(*) FROM biochoco_identifications WHERE corrected_species = ?) AS asCorrected`
    )
    .get(scientificName, scientificName);
  return row;
}

function getSpecies(scientificName) {
  return db
    .prepare("SELECT * FROM biochoco_species WHERE scientific_name = ?")
    .get(scientificName);
}

// ─── 1. Potos flavos → Potos flavus ────────────────────────────────────────

const potosOld = getSpecies("Potos flavos");
if (potosOld) {
  const usage = countIdentifications("Potos flavos");
  console.log(`1. RENAME: Potos flavos → Potos flavus`);
  console.log(`   Identifications referencing: species=${usage.asSpecies}, corrected=${usage.asCorrected}`);
  if (!dryRun) {
    db.transaction(() => {
      db.prepare("UPDATE biochoco_species SET scientific_name = ? WHERE id = ?").run(
        "Potos flavus",
        potosOld.id
      );
      db.prepare("UPDATE biochoco_identifications SET species = ? WHERE species = ?").run(
        "Potos flavus",
        "Potos flavos"
      );
      db.prepare("UPDATE biochoco_identifications SET corrected_species = ? WHERE corrected_species = ?").run(
        "Potos flavus",
        "Potos flavos"
      );
    })();
    console.log("   ✓ Applied\n");
  } else {
    console.log("");
  }
} else {
  console.log("1. SKIP: Potos flavos not found (already fixed?)\n");
}

// ─── 2. Leopardus wiedii type: system → mammal ──────────────────────────────

const margay = getSpecies("Leopardus wiedii");
if (margay) {
  console.log(`2. UPDATE TYPE: Leopardus wiedii — ${margay.type} → mammal`);
  if (margay.type === "mammal") {
    console.log("   Already correct, skipping\n");
  } else if (!dryRun) {
    db.prepare("UPDATE biochoco_species SET type = ? WHERE id = ?").run("mammal", margay.id);
    console.log("   ✓ Applied\n");
  } else {
    console.log("");
  }
} else {
  console.log("2. SKIP: Leopardus wiedii not found\n");
}

// ─── 3. Sciuridae sp. → merge into Sciurus sp. ─────────────────────────────

const sciuridae = getSpecies("Sciuridae sp.");
const sciurus = getSpecies("Sciurus sp.");
if (sciuridae && sciurus) {
  const usage = countIdentifications("Sciuridae sp.");
  console.log(`3. MERGE: Sciuridae sp. (id=${sciuridae.id}) → Sciurus sp. (id=${sciurus.id})`);
  console.log(`   Identifications to reassign: species=${usage.asSpecies}, corrected=${usage.asCorrected}`);
  if (!dryRun) {
    db.transaction(() => {
      db.prepare("UPDATE biochoco_identifications SET species = ? WHERE species = ?").run(
        "Sciurus sp.",
        "Sciuridae sp."
      );
      db.prepare("UPDATE biochoco_identifications SET corrected_species = ? WHERE corrected_species = ?").run(
        "Sciurus sp.",
        "Sciuridae sp."
      );
      db.prepare("DELETE FROM biochoco_species WHERE id = ?").run(sciuridae.id);
    })();
    console.log("   ✓ Applied\n");
  } else {
    console.log("");
  }
} else {
  console.log(`3. SKIP: Sciuridae sp. ${sciuridae ? "found" : "not found"}, Sciurus sp. ${sciurus ? "found" : "not found"}\n`);
}

// ─── 4. Procyon sp. → merge into Procyon cancrivorus ────────────────────────

const procyonSp = getSpecies("Procyon sp.");
const procyonC = getSpecies("Procyon cancrivorus");
if (procyonSp && procyonC) {
  const usage = countIdentifications("Procyon sp.");
  console.log(`4. MERGE: Procyon sp. (id=${procyonSp.id}) → Procyon cancrivorus (id=${procyonC.id})`);
  console.log(`   Identifications to reassign: species=${usage.asSpecies}, corrected=${usage.asCorrected}`);
  if (!dryRun) {
    db.transaction(() => {
      db.prepare("UPDATE biochoco_identifications SET species = ? WHERE species = ?").run(
        "Procyon cancrivorus",
        "Procyon sp."
      );
      db.prepare("UPDATE biochoco_identifications SET corrected_species = ? WHERE corrected_species = ?").run(
        "Procyon cancrivorus",
        "Procyon sp."
      );
      db.prepare("DELETE FROM biochoco_species WHERE id = ?").run(procyonSp.id);
    })();
    console.log("   ✓ Applied\n");
  } else {
    console.log("");
  }
} else {
  console.log(`4. SKIP: Procyon sp. ${procyonSp ? "found" : "not found"}, Procyon cancrivorus ${procyonC ? "found" : "not found"}\n`);
}

// ─── 5. Dasyprocta punctata spanish_name: Guanta → Guatusa ─────────────────

const agouti = getSpecies("Dasyprocta punctata");
if (agouti) {
  console.log(`5. FIX SPANISH NAME: Dasyprocta punctata — "${agouti.spanish_name}" → "Guatusa"`);
  if (!dryRun) {
    db.prepare("UPDATE biochoco_species SET spanish_name = ? WHERE id = ?").run("Guatusa", agouti.id);
    console.log("   ✓ Applied\n");
  } else {
    console.log("");
  }
} else {
  console.log("5. SKIP: Dasyprocta punctata not found\n");
}

// ─── 6. Canis familiaris → Canis lupus familiaris ───────────────────────────

const dog = getSpecies("Canis familiaris");
if (dog) {
  const usage = countIdentifications("Canis familiaris");
  console.log(`6. RENAME: Canis familiaris → Canis lupus familiaris`);
  console.log(`   Identifications referencing: species=${usage.asSpecies}, corrected=${usage.asCorrected}`);
  if (!dryRun) {
    db.transaction(() => {
      db.prepare("UPDATE biochoco_species SET scientific_name = ? WHERE id = ?").run(
        "Canis lupus familiaris",
        dog.id
      );
      db.prepare("UPDATE biochoco_identifications SET species = ? WHERE species = ?").run(
        "Canis lupus familiaris",
        "Canis familiaris"
      );
      db.prepare("UPDATE biochoco_identifications SET corrected_species = ? WHERE corrected_species = ?").run(
        "Canis lupus familiaris",
        "Canis familiaris"
      );
    })();
    console.log("   ✓ Applied\n");
  } else {
    console.log("");
  }
} else {
  console.log("6. SKIP: Canis familiaris not found (already fixed?)\n");
}

db.close();

if (dryRun) {
  console.log("=== DRY RUN complete. Run with --apply to execute changes. ===");
} else {
  console.log("=== All changes applied successfully. ===");
}
