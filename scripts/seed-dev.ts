/**
 * Seed development data: projects, super admin user, species.
 *
 * Run with: npx tsx scripts/seed-dev.ts
 */

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const dbPath = process.env.DB_PATH || "data/portal.db";
const fullPath = path.isAbsolute(dbPath)
  ? dbPath
  : path.join(process.cwd(), dbPath);

const dir = path.dirname(fullPath);
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

const db = new Database(fullPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// --- Projects ---
const insertProject = db.prepare(
  "INSERT OR IGNORE INTO projects (id, name, description) VALUES (?, ?, ?)"
);

insertProject.run(
  "camera-trap",
  "Cámaras Trampa",
  "Pipeline de procesamiento de imágenes de cámaras trampa con detección y clasificación de especies"
);
insertProject.run(
  "giz",
  "GIZ",
  "Proyecto GIZ - Siembra de árboles y monitoreo de cacao"
);
insertProject.run(
  "biochoco",
  "BioChoco",
  "Programa de monitoreo de biodiversidad BioChoco"
);
insertProject.run(
  "finance",
  "Finanzas",
  "Dashboard financiero y gestión de presupuestos"
);

console.log("Seeded projects: camera-trap, giz, biochoco, finance");

// --- Super admin user ---
const superAdminEmail =
  process.env.SUPER_ADMIN_EMAILS?.split(",")[0]?.trim() ||
  "lukebrowne@fcat-ecuador.org";

db.prepare(
  "INSERT OR IGNORE INTO users (email, name, is_external, global_role) VALUES (?, ?, ?, ?)"
).run(superAdminEmail, "Luke Browne", 0, "super_admin");

// Grant super admin access to all projects
db.prepare(
  "INSERT OR IGNORE INTO user_permissions (user_email, project_id, role) VALUES (?, ?, ?)"
).run(superAdminEmail, "camera-trap", "admin");
db.prepare(
  "INSERT OR IGNORE INTO user_permissions (user_email, project_id, role) VALUES (?, ?, ?)"
).run(superAdminEmail, "giz", "admin");
db.prepare(
  "INSERT OR IGNORE INTO user_permissions (user_email, project_id, role) VALUES (?, ?, ?)"
).run(superAdminEmail, "biochoco", "admin");
db.prepare(
  "INSERT OR IGNORE INTO user_permissions (user_email, project_id, role) VALUES (?, ?, ?)"
).run(superAdminEmail, "finance", "admin");

console.log(`Seeded super admin: ${superAdminEmail}`);

// --- Species ---
const speciesList = [
  // System categories
  { scientific_name: "blank", common_name: "Blank (No Animal)", type: "system" },
  { scientific_name: "unknown", common_name: "Unknown", type: "system" },
  { scientific_name: "homo_sapiens", common_name: "Person", type: "system" },
  { scientific_name: "vehicle", common_name: "Vehicle", type: "system" },

  // Common neotropical mammals (western Ecuador focus)
  { scientific_name: "Dasyprocta punctata", common_name: "Central American Agouti", type: "mammal" },
  { scientific_name: "Cuniculus paca", common_name: "Lowland Paca", type: "mammal" },
  { scientific_name: "Pecari tajacu", common_name: "Collared Peccary", type: "mammal" },
  { scientific_name: "Tayassu pecari", common_name: "White-lipped Peccary", type: "mammal" },
  { scientific_name: "Mazama americana", common_name: "Red Brocket Deer", type: "mammal" },
  { scientific_name: "Mazama zamora", common_name: "Zamora Brocket Deer", type: "mammal" },
  { scientific_name: "Odocoileus virginianus", common_name: "White-tailed Deer", type: "mammal" },
  { scientific_name: "Tapirus bairdii", common_name: "Baird's Tapir", type: "mammal" },
  { scientific_name: "Panthera onca", common_name: "Jaguar", type: "mammal" },
  { scientific_name: "Puma concolor", common_name: "Puma", type: "mammal" },
  { scientific_name: "Leopardus pardalis", common_name: "Ocelot", type: "mammal" },
  { scientific_name: "Leopardus wiedii", common_name: "Margay", type: "mammal" },
  { scientific_name: "Herpailurus yagouaroundi", common_name: "Jaguarundi", type: "mammal" },
  { scientific_name: "Eira barbara", common_name: "Tayra", type: "mammal" },
  { scientific_name: "Nasua narica", common_name: "White-nosed Coati", type: "mammal" },
  { scientific_name: "Procyon cancrivorus", common_name: "Crab-eating Raccoon", type: "mammal" },
  { scientific_name: "Potos flavus", common_name: "Kinkajou", type: "mammal" },
  { scientific_name: "Tamandua mexicana", common_name: "Northern Tamandua", type: "mammal" },
  { scientific_name: "Dasypus novemcinctus", common_name: "Nine-banded Armadillo", type: "mammal" },
  { scientific_name: "Cabassous centralis", common_name: "Northern Naked-tailed Armadillo", type: "mammal" },
  { scientific_name: "Didelphis marsupialis", common_name: "Common Opossum", type: "mammal" },
  { scientific_name: "Philander opossum", common_name: "Gray Four-eyed Opossum", type: "mammal" },
  { scientific_name: "Sciurus granatensis", common_name: "Red-tailed Squirrel", type: "mammal" },
  { scientific_name: "Sylvilagus brasiliensis", common_name: "Tapeti", type: "mammal" },
  { scientific_name: "Caluromys derbianus", common_name: "Derby's Woolly Opossum", type: "mammal" },
  { scientific_name: "Conepatus semistriatus", common_name: "Striped Hog-nosed Skunk", type: "mammal" },

  // Common birds detected by camera traps
  { scientific_name: "Tinamus major", common_name: "Great Tinamou", type: "bird" },
  { scientific_name: "Crypturellus soui", common_name: "Little Tinamou", type: "bird" },
  { scientific_name: "Crax rubra", common_name: "Great Curassow", type: "bird" },
  { scientific_name: "Penelope purpurascens", common_name: "Crested Guan", type: "bird" },
  { scientific_name: "Odontophorus erythrops", common_name: "Rufous-fronted Wood-Quail", type: "bird" },
  { scientific_name: "Columba subvinacea", common_name: "Ruddy Pigeon", type: "bird" },

  // Reptiles
  { scientific_name: "Iguana iguana", common_name: "Green Iguana", type: "reptile" },
  { scientific_name: "Boa constrictor", common_name: "Boa Constrictor", type: "reptile" },
];

const insertSpecies = db.prepare(
  "INSERT OR IGNORE INTO species (scientific_name, common_name, type) VALUES (?, ?, ?)"
);

let insertedCount = 0;
const insertMany = db.transaction(() => {
  for (const sp of speciesList) {
    const result = insertSpecies.run(
      sp.scientific_name,
      sp.common_name,
      sp.type
    );
    if (result.changes > 0) insertedCount++;
  }
});

insertMany();

const total = db.prepare("SELECT COUNT(*) as count FROM species").get() as {
  count: number;
};
console.log(
  `Seeded species: ${insertedCount} new entries added (${total.count} total)`
);

db.close();
console.log("Done.");
