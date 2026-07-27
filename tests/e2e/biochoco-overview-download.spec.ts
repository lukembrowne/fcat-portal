import { test, expect } from "@playwright/test";

/**
 * Self-contained download of the public overview.
 *
 * Locally there may be no published snapshot (the endpoint 404s until an admin
 * publishes). When a snapshot exists, the route returns a single attachment HTML
 * file whose faithful copy and inlined images render offline (AE5).
 */
test.describe("public overview download", () => {
  test("returns a self-contained attachment with the faithful copy when published, else 404", async ({
    request,
  }) => {
    const res = await request.get("/public/biochoco-overview/download?lang=es");
    if (res.status() === 404) {
      test.info().annotations.push({ type: "note", description: "no snapshot published locally" });
      return;
    }
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/html");
    expect(res.headers()["content-disposition"]).toContain("attachment");
    const body = await res.text();
    // Self-contained: images are inlined as data URIs, not remote src.
    expect(body).not.toMatch(/<img[^>]+src="https?:\/\//i);
    // Faithful copy (Spanish): hero title + a couple of section headings.
    expect(body).toContain("BioChocó");
    expect(body).toContain("Detecciones de especies");
    expect(body).toContain("Una plataforma integrada de extremo a extremo");
  });

  test("english export carries the Desktop's verbatim English headings", async ({ request }) => {
    const res = await request.get("/public/biochoco-overview/download?lang=en");
    if (res.status() === 404) {
      test.info().annotations.push({ type: "note", description: "no snapshot published locally" });
      return;
    }
    const body = await res.text();
    expect(body).toContain("Species detections");
    expect(body).toContain("An integrated end-to-end platform");
    expect(body).toContain("Where collaborators come in");
  });
});
