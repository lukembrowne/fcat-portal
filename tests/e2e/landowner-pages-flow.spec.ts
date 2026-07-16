import { test, expect } from "@playwright/test";

/**
 * Landowner public-pages flow (U5).
 *
 * Runs as super_admin (DEV_USER_EMAIL), so the biochoco "Páginas públicas"
 * section and the dedicated builder route are reachable. Selectors stay
 * resilient (getByRole / Spanish getByText) because the underlying fixture
 * data (sites, share tokens) is not guaranteed in every environment — where a
 * precondition is missing the test annotates and returns instead of failing.
 */
test.describe("Landowner public pages", () => {
  test("section table links each row to the dedicated builder route", async ({
    page,
  }) => {
    await page.goto("/biochoco/paginas-publicas");
    await expect(
      page.getByRole("heading", { name: "Páginas públicas" })
    ).toBeVisible();

    const editar = page.getByRole("link", { name: /Editar/i }).first();
    if (!(await editar.isVisible().catch(() => false))) {
      test.info().annotations.push({
        type: "note",
        description: "no sites/rows available locally",
      });
      return;
    }

    await editar.click();
    await page.waitForURL(/\/biochoco\/paginas-publicas\/.+/);

    // Breadcrumb back to the section.
    await expect(
      page.getByRole("link", { name: "Páginas públicas" })
    ).toBeVisible();
  });

  test("builder route shows the page builder (with live preview) when a link is published, else the publish empty state", async ({
    page,
  }) => {
    await page.goto("/biochoco/paginas-publicas");

    const editar = page.getByRole("link", { name: /Editar/i }).first();
    if (!(await editar.isVisible().catch(() => false))) {
      test.info().annotations.push({
        type: "note",
        description: "no sites/rows available locally",
      });
      return;
    }
    await editar.click();
    await page.waitForURL(/\/biochoco\/paginas-publicas\/.+/);

    const builder = page.getByText("Personalizar página pública");
    const emptyState = page.getByText("Aún no hay una página publicada");

    if (await builder.isVisible().catch(() => false)) {
      // Active token → PageBuilder is rendered. Open it and reveal the preview.
      await page.getByRole("button", { name: "Editar" }).first().click();
      const previewToggle = page.getByRole("button", {
        name: /Vista previa/i,
      });
      await expect(previewToggle).toBeVisible();
      await previewToggle.click();
      await expect(
        page.getByTitle("Vista previa de la página del propietario")
      ).toBeVisible();
    } else {
      // No active token → friendly empty state with the publish action.
      await expect(emptyState).toBeVisible();
      await expect(
        page.getByRole("button", { name: /Compartir/i })
      ).toBeVisible();
    }
  });

  test("internal Resultados detail shows the public-page jump link and no builder", async ({
    page,
  }) => {
    // Reach a site detail via the Resultados listing.
    await page.goto("/biochoco/resultados");
    const siteLink = page
      .getByRole("link")
      .filter({ hasText: /_/ })
      .first();
    if (!(await siteLink.isVisible().catch(() => false))) {
      test.info().annotations.push({
        type: "note",
        description: "no sites available locally",
      });
      return;
    }
    await siteLink.click();
    await page.waitForURL(/\/biochoco\/resultados\/.+/);

    // The internal view is now purely internal: a jump link, never the builder.
    await expect(
      page.getByRole("link", { name: /Editar página pública/i })
    ).toBeVisible();
    await expect(
      page.getByText("Personalizar página pública")
    ).toHaveCount(0);

    // The jump link points into the Páginas públicas section.
    await page
      .getByRole("link", { name: /Editar página pública/i })
      .click();
    await page.waitForURL(/\/biochoco\/paginas-publicas\/.+/);
  });
});
