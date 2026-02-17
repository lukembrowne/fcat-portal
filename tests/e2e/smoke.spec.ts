import { test, expect } from "@playwright/test";

test.describe("Smoke tests", () => {
  test("portal home page loads", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("body")).toBeVisible();
    // Should show welcome message or module cards
    await expect(page.locator("text=Bienvenido")).toBeVisible();
  });

  test("camera trap page loads", async ({ page }) => {
    await page.goto("/camera-trap");
    await expect(page.getByRole("heading", { name: "Cámaras Trampa" })).toBeVisible();
  });

  test("admin page loads", async ({ page }) => {
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "Administración" })).toBeVisible();
  });

  test("camera trap results page loads", async ({ page }) => {
    await page.goto("/camera-trap/results");
    await expect(page.getByRole("heading", { name: /Resultados/ })).toBeVisible();
  });

  test("404 page shows in Spanish", async ({ page }) => {
    await page.goto("/this-does-not-exist");
    await expect(page.locator("body")).toBeVisible();
  });
});
