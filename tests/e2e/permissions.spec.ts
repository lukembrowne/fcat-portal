import { test, expect } from "@playwright/test";

/**
 * Permission boundary tests
 *
 * These tests verify that:
 * - Pages load correctly for the default dev user (super_admin)
 * - Sidebar navigation reflects user permissions
 *
 * NOTE: Testing non-admin access requires changing DEV_USER_EMAIL/DEV_USER_ROLE
 * env vars, which is beyond simple E2E smoke tests. For now, we verify that
 * the permission-filtered UI works for the super_admin dev user.
 */

test.describe("Permission boundaries", () => {
  test("super admin sees admin link in sidebar", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("[data-slot='sidebar'] >> text=Panel de Admin")).toBeVisible();
  });

  test("super admin sees camera trap link in sidebar", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("[data-slot='sidebar'] >> text=Cámaras Trampa")).toBeVisible();
  });

  test("admin page shows user table", async ({ page }) => {
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "Administración" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Agregar Usuario" })).toBeVisible();
  });
});
