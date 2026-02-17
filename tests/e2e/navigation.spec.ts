import { test, expect } from "@playwright/test";

/**
 * Navigation & Sidebar E2E Tests
 *
 * Tests sidebar navigation, cross-module links, and breadcrumb behavior.
 * Runs as super_admin (DEV_USER_EMAIL), so all sections should be visible.
 */

test.describe("Sidebar navigation", () => {
  test("sidebar shows all project sections for super admin", async ({ page }) => {
    await page.goto("/");

    const sidebar = page.locator("[data-slot='sidebar']");
    await expect(sidebar).toBeVisible();

    // Project sections
    await expect(sidebar.locator("text=GIZ")).toBeVisible();
    await expect(sidebar.locator("text=BioChocó")).toBeVisible();
    await expect(sidebar.locator("text=Datos Climáticos")).toBeVisible();

    // Analysis section
    await expect(sidebar.locator("text=Cámaras Trampa")).toBeVisible();

    // Admin section
    await expect(sidebar.locator("text=Finanzas")).toBeVisible();
    await expect(sidebar.locator("text=Panel de Admin")).toBeVisible();
  });

  test("can navigate to camera trap from sidebar", async ({ page }) => {
    await page.goto("/");

    // Click the camera trap section in sidebar to expand it
    const cameraTrapButton = page.locator(
      "[data-slot='sidebar'] >> button:has-text('Cámaras Trampa')"
    );
    await cameraTrapButton.click();

    // Click the Dashboard sub-link
    const dashboardLink = page.locator(
      "[data-slot='sidebar-menu-sub'] >> a:has-text('Dashboard')"
    );
    if (await dashboardLink.isVisible()) {
      await dashboardLink.click();
      await page.waitForURL("/camera-trap");
      await expect(page.getByRole("heading", { name: "Cámaras Trampa" })).toBeVisible();
    }
  });

  test("can navigate to finance sections from sidebar", async ({ page }) => {
    await page.goto("/");

    // Click Finanzas to expand
    const financeButton = page.locator(
      "[data-slot='sidebar'] >> button:has-text('Finanzas')"
    );
    await financeButton.click();

    // Click Flujo de Caja sub-link
    const cashflowLink = page.locator(
      "[data-slot='sidebar-menu-sub'] >> a:has-text('Flujo de Caja')"
    );
    if (await cashflowLink.isVisible()) {
      await cashflowLink.click();
      await page.waitForURL("/finance/cashflow");
    }
  });

  test("can navigate to admin page from sidebar", async ({ page }) => {
    await page.goto("/");

    const adminLink = page.locator(
      "[data-slot='sidebar'] >> a:has-text('Panel de Admin')"
    );
    await adminLink.click();
    await page.waitForURL("/admin");
    await expect(page.getByRole("heading", { name: "Administración" })).toBeVisible();
  });

  test("sidebar shows user info in footer", async ({ page }) => {
    await page.goto("/");

    const sidebarFooter = page.locator("[data-slot='sidebar-footer']");
    await expect(sidebarFooter).toBeVisible();
  });
});

test.describe("Cross-module navigation", () => {
  test("home page shows module cards", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("text=Bienvenido")).toBeVisible();
  });

  test("finance redirects to cashflow", async ({ page }) => {
    await page.goto("/finance");
    await page.waitForURL("/finance/cashflow");
  });

  test("all finance sub-pages load", async ({ page }) => {
    test.setTimeout(60000);

    const routes = [
      "/finance/cashflow",
      "/finance/revenue",
      "/finance/expenses",
      "/finance/sueldos",
      "/finance/budget",
      "/finance/annual",
    ];

    for (const route of routes) {
      await page.goto(route);
      // Each page should render without error
      await expect(page.locator("body")).toBeVisible();
    }
  });

  test("climate dashboard loads", async ({ page }) => {
    await page.goto("/climate/dashboard");
    await expect(page.locator("body")).toBeVisible();
  });

  test("biochoco overview loads", async ({ page }) => {
    await page.goto("/biochoco/overview");
    await expect(page.locator("body")).toBeVisible();
  });
});
