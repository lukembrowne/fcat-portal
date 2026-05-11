import { test, expect } from "@playwright/test";

/**
 * Acoustic Indices E2E smoke tests.
 *
 * The /audio/indices page is project-scoped. For a dev super-admin, it
 * should render the title, project selector, diel-period tab nav, and
 * (when no data has been computed yet) an empty-state message — but the
 * shell must NEVER 500. That's the bar this smoke test enforces.
 *
 * The full "trigger → wait → assert boxplots render" loop relies on the
 * Python runner being installed inside the container; covered by the
 * Python unit + integration tests, not by Playwright.
 */

test.describe("Acoustic indices page", () => {
  test("loads and shows the page header", async ({ page }) => {
    await page.goto("/audio/indices");
    await expect(
      page.getByRole("heading", {
        name: /Comparación de paisajes sonoros entre sitios/,
      })
    ).toBeVisible();
  });

  test("renders the diel-period tab nav", async ({ page }) => {
    await page.goto("/audio/indices");
    await expect(page.getByRole("navigation", { name: "Ventana diaria" })).toBeVisible();
    await expect(page.getByRole("link", { name: /Madrugada/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /Mediodía/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /Crepúsculo/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /^Noche/ })).toBeVisible();
  });

  test("switching diel-period updates the URL search param", async ({ page }) => {
    await page.goto("/audio/indices");
    await page.getByRole("link", { name: /Mediodía/ }).click();
    await expect(page).toHaveURL(/period=midday/);
  });

  test("sidebar exposes the Índices acústicos link", async ({ page }) => {
    await page.goto("/audio");
    const sidebar = page.locator("[data-slot='sidebar']");
    await expect(sidebar.getByRole("link", { name: /Índices acústicos/ })).toBeVisible();
  });
});
