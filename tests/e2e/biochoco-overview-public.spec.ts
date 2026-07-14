import { test, expect } from "@playwright/test";

/**
 * Public BioChoco overview page (tokenless, under the /public/* carve-out).
 *
 * Note on AE1's auth-block half (an unauthenticated request to /biochoco must be
 * challenged): that is enforced by oauth2-proxy at the nginx layer, which is not
 * present in local dev (DEV_USER_EMAIL bypasses it). It is verified in staging/
 * prod, not here. This spec covers the public-render half.
 */
test.describe("public biochoco overview", () => {
  test("renders without auth (report content or coming-soon state)", async ({ page }) => {
    await page.goto("/public/biochoco-overview");
    await expect(page.locator("body")).toBeVisible();
    // Either a published report (has an h1 title) or the coming-soon fallback.
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  test("language toggle switches copy when a snapshot is published", async ({ page }) => {
    await page.goto("/public/biochoco-overview");
    const toggle = page.getByRole("button", { name: /Switch language/i });
    // Toggle only renders on the published page, not the coming-soon fallback.
    if (await toggle.count()) {
      const before = await page.getByRole("heading", { level: 1 }).textContent();
      await toggle.click();
      const after = await page.getByRole("heading", { level: 1 }).textContent();
      expect(after).not.toEqual(before);
    }
  });
});
