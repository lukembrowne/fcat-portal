import { test, expect } from "@playwright/test";

/**
 * Permission boundary tests
 *
 * These tests verify that:
 * - Pages load correctly for the default dev user (super_admin)
 * - Navigation reflects user permissions
 *
 * NOTE: Testing non-admin access requires changing DEV_USER_EMAIL/DEV_USER_ROLE
 * env vars, which is beyond simple E2E smoke tests. For now, we verify that
 * the permission-filtered UI works for the super_admin dev user.
 */

test.describe("Permission boundaries", () => {
  test("super admin sees admin link in nav", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("nav")).toBeVisible();
    await expect(page.locator("nav >> text=Administración")).toBeVisible();
  });

  test("super admin sees camera trap link in nav", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("nav >> text=Cámaras Trampa")).toBeVisible();
  });

  test("admin page shows user table", async ({ page }) => {
    await page.goto("/admin");
    await expect(page.locator("text=Usuarios")).toBeVisible();
    await expect(page.locator("text=Agregar Usuario")).toBeVisible();
  });
});
