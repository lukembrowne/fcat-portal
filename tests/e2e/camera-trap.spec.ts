import { test, expect } from "@playwright/test";

/**
 * Camera Trap Workflow E2E Tests
 *
 * Tests the core workflow: deployments table → results → image grid → annotation.
 * Assumes dev DB has at least one deployment with a completed job.
 */

test.describe("Camera trap workflow", () => {
  test("deployments page loads with table", async ({ page }) => {
    await page.goto("/camera-trap");
    await expect(page.getByRole("heading", { name: "Cámaras Trampa" })).toBeVisible({ timeout: 15000 });

    // Should show the deployments table
    await expect(page.locator("table")).toBeVisible();
  });

  test("results page loads with stats cards", async ({ page }) => {
    await page.goto("/camera-trap/results");
    await expect(page.getByRole("heading", { name: /Resultados/ })).toBeVisible();

    // Should show stat cards (use role to avoid matching table headers)
    await expect(page.getByText("Imágenes Procesadas")).toBeVisible();
    await expect(page.getByText("Especies", { exact: true }).first()).toBeVisible();
  });

  test("can navigate from results table to job detail", async ({ page }) => {
    await page.goto("/camera-trap/results");

    // Results table uses router.push on row click, not <a> links
    const firstRow = page.locator("table tbody tr").first();
    const hasJobs = await firstRow.isVisible().catch(() => false);

    if (!hasJobs) {
      test.skip();
      return;
    }

    await firstRow.click();
    await page.waitForURL(/\/camera-trap\/results\/\d+/);

    // Should show the job detail page with breadcrumb
    await expect(page.locator("a[href='/camera-trap']").first()).toBeVisible();
  });

  test("job detail page shows filter sidebar and image grid", async ({ page }) => {
    await page.goto("/camera-trap/results");

    const firstRow = page.locator("table tbody tr").first();
    const hasJobs = await firstRow.isVisible().catch(() => false);
    if (!hasJobs) {
      test.skip();
      return;
    }

    await firstRow.click();
    await page.waitForURL(/\/camera-trap\/results\/\d+/);

    // Should show filter sidebar
    await expect(page.getByText("Filtros", { exact: true })).toBeVisible();
    await expect(page.getByText("Verificación", { exact: true })).toBeVisible();

    // Should show image count heading
    await expect(page.getByText(/Imágenes \(\d+/)).toBeVisible();
  });

  test("can click an image to open annotation page", async ({ page }) => {
    await page.goto("/camera-trap/results");

    const firstRow = page.locator("table tbody tr").first();
    const hasJobs = await firstRow.isVisible().catch(() => false);
    if (!hasJobs) {
      test.skip();
      return;
    }

    await firstRow.click();
    await page.waitForURL(/\/camera-trap\/results\/\d+/);

    // Wait for image grid to render, then click first image link
    const imageLink = page.locator("a[href*='/images/']").first();
    const hasImages = await imageLink.isVisible().catch(() => false);
    if (!hasImages) {
      test.skip();
      return;
    }

    await imageLink.click();
    await page.waitForURL(/\/camera-trap\/results\/\d+\/images\/\d+/);

    // Annotation page should show navigation buttons
    await expect(
      page.getByRole("link", { name: "Anterior" })
        .or(page.locator("span:has-text('Anterior')"))
    ).toBeVisible();

    // Should show image position indicator (e.g. "1 de 7")
    await expect(page.getByText(/\d+ de \d+/)).toBeVisible();
  });

  test("annotation page has breadcrumb navigation", async ({ page }) => {
    await page.goto("/camera-trap/results");

    const firstRow = page.locator("table tbody tr").first();
    const hasJobs = await firstRow.isVisible().catch(() => false);
    if (!hasJobs) {
      test.skip();
      return;
    }

    await firstRow.click();
    await page.waitForURL(/\/camera-trap\/results\/\d+/);

    const imageLink = page.locator("a[href*='/images/']").first();
    const hasImages = await imageLink.isVisible().catch(() => false);
    if (!hasImages) {
      test.skip();
      return;
    }

    await imageLink.click();
    await page.waitForURL(/\/camera-trap\/results\/\d+\/images\/\d+/);

    // Breadcrumb should link back to camera trap and the job
    const breadcrumbCameraTrap = page.locator("a[href='/camera-trap']").first();
    await expect(breadcrumbCameraTrap).toBeVisible();

    const breadcrumbJob = page.locator("a[href*='/camera-trap/results/']").first();
    await expect(breadcrumbJob).toBeVisible();
  });

  test("verification filter buttons work on results page", async ({ page }) => {
    await page.goto("/camera-trap/results");

    const firstRow = page.locator("table tbody tr").first();
    const hasJobs = await firstRow.isVisible().catch(() => false);
    if (!hasJobs) {
      test.skip();
      return;
    }

    await firstRow.click();
    await page.waitForURL(/\/camera-trap\/results\/\d+/);

    // Click "Sin verificar" filter
    const unverifiedBtn = page.locator("button:has-text('Sin verificar')");
    if (await unverifiedBtn.isVisible()) {
      await unverifiedBtn.click();

      // "Limpiar" button should appear (active filters indicator)
      await expect(page.locator("button:has-text('Limpiar')")).toBeVisible();

      // Click "Todos" to clear
      await page.locator("button:has-text('Todos')").click();
    }
  });

  test("species management page loads", async ({ page }) => {
    await page.goto("/camera-trap/species");
    await expect(page.getByRole("heading", { name: /Especies/ })).toBeVisible();
  });
});
