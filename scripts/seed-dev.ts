/**
 * Seed development data: projects and super admin user.
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
insertProject.run(
  "climate",
  "Datos Climáticos",
  "Datos de la estación meteorológica central de FCAT"
);

console.log("Seeded projects: camera-trap, giz, biochoco, finance, climate");

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
db.prepare(
  "INSERT OR IGNORE INTO user_permissions (user_email, project_id, role) VALUES (?, ?, ?)"
).run(superAdminEmail, "climate", "admin");

console.log(`Seeded super admin: ${superAdminEmail}`);

db.close();
console.log("Done.");
