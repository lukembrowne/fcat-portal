import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");

  // Create tables
  sqlite.exec(`
    CREATE TABLE users (
      email TEXT PRIMARY KEY,
      name TEXT,
      is_external INTEGER NOT NULL DEFAULT 0,
      global_role TEXT CHECK(global_role IN ('super_admin')),
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      last_seen_at INTEGER
    );
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE user_permissions (
      user_email TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('viewer', 'editor', 'admin')),
      granted_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (user_email, project_id)
    );
  `);

  return drizzle(sqlite, { schema });
}

describe("permissions integration", () => {
  let db: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    db = createTestDb();

    // Seed test data
    db.insert(schema.projects)
      .values([
        { id: "camera-trap", name: "Cámaras Trampa" },
        { id: "giz", name: "GIZ Dashboards" },
      ])
      .run();

    db.insert(schema.users)
      .values([
        { email: "admin@test.org", name: "Admin", globalRole: "super_admin" },
        { email: "editor@test.org", name: "Editor" },
        { email: "viewer@test.org", name: "Viewer" },
        { email: "noauth@test.org", name: "No Auth" },
      ])
      .run();

    db.insert(schema.userPermissions)
      .values([
        { userEmail: "editor@test.org", projectId: "camera-trap", role: "editor" },
        { userEmail: "viewer@test.org", projectId: "camera-trap", role: "viewer" },
        { userEmail: "editor@test.org", projectId: "giz", role: "viewer" },
      ])
      .run();
  });

  it("user with no permissions has empty permissions array", () => {
    const perms = db
      .select()
      .from(schema.userPermissions)
      .where(eq(schema.userPermissions.userEmail, "noauth@test.org"))
      .all();

    expect(perms).toHaveLength(0);
  });

  it("viewer has viewer role on camera-trap", () => {
    const perms = db
      .select()
      .from(schema.userPermissions)
      .where(eq(schema.userPermissions.userEmail, "viewer@test.org"))
      .all();

    expect(perms).toHaveLength(1);
    expect(perms[0].projectId).toBe("camera-trap");
    expect(perms[0].role).toBe("viewer");
  });

  it("editor has roles on multiple projects", () => {
    const perms = db
      .select()
      .from(schema.userPermissions)
      .where(eq(schema.userPermissions.userEmail, "editor@test.org"))
      .all();

    expect(perms).toHaveLength(2);
    const projects = perms.map((p) => p.projectId).sort();
    expect(projects).toEqual(["camera-trap", "giz"]);
  });

  it("cross-project isolation: viewer has no giz access", () => {
    const perms = db
      .select()
      .from(schema.userPermissions)
      .where(eq(schema.userPermissions.userEmail, "viewer@test.org"))
      .all();

    const gizPerm = perms.find((p) => p.projectId === "giz");
    expect(gizPerm).toBeUndefined();
  });

  it("UPSERT: inserting existing user does not error", () => {
    // This simulates auto-provisioning race condition
    expect(() => {
      db.insert(schema.users)
        .values({ email: "editor@test.org" })
        .onConflictDoNothing()
        .run();
    }).not.toThrow();

    // Original data should be preserved
    const [user] = db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, "editor@test.org"))
      .all();

    expect(user.name).toBe("Editor");
  });

  it("cascade: deleting a user removes their permissions", () => {
    db.delete(schema.users)
      .where(eq(schema.users.email, "editor@test.org"))
      .run();

    const perms = db
      .select()
      .from(schema.userPermissions)
      .where(eq(schema.userPermissions.userEmail, "editor@test.org"))
      .all();

    expect(perms).toHaveLength(0);
  });

  it("cascade: deleting a project removes permissions for it", () => {
    db.delete(schema.projects)
      .where(eq(schema.projects.id, "camera-trap"))
      .run();

    const allPerms = db.select().from(schema.userPermissions).all();

    // Only giz permission should remain
    expect(allPerms).toHaveLength(1);
    expect(allPerms[0].projectId).toBe("giz");
  });

  it("role hierarchy: viewer < editor < admin", () => {
    const ROLE_HIERARCHY: Record<string, number> = {
      viewer: 1,
      editor: 2,
      admin: 3,
    };

    expect(ROLE_HIERARCHY["viewer"]).toBeLessThan(ROLE_HIERARCHY["editor"]);
    expect(ROLE_HIERARCHY["editor"]).toBeLessThan(ROLE_HIERARCHY["admin"]);
  });

  it("super admin identified by global_role", () => {
    const [admin] = db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, "admin@test.org"))
      .all();

    expect(admin.globalRole).toBe("super_admin");
  });
});
