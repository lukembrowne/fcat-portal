import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PageShare } from "../page-share";
import {
  buildWhatsAppShareUrl,
  PAGE_SHARE_MESSAGE,
} from "@/lib/landowner/copy";

/**
 * The repo Vitest env is "node" (no jsdom), so we render PageShare to a static
 * HTML string and assert the WhatsApp anchor + accessible names. The click
 * handlers (navigator.share / clipboard) are not exercised here.
 */

const PUBLIC_URL = "https://portal.fcat-ecuador.org/public/biochoco/tok123";

describe("PageShare (U12)", () => {
  const html = renderToStaticMarkup(
    <PageShare publicUrl={PUBLIC_URL} title="Finca La Esperanza" />,
  );

  it("renders a WhatsApp link whose href encodes the message + page URL", () => {
    const expectedHref = buildWhatsAppShareUrl(PUBLIC_URL);
    expect(html).toContain(`href="${expectedHref}"`);
    // Sanity: the encoded href carries both the message and the URL.
    const decoded = decodeURIComponent(expectedHref);
    expect(decoded).toContain(PAGE_SHARE_MESSAGE);
    expect(decoded).toContain(PUBLIC_URL);
  });

  it("exposes Spanish aria-labels on every share control", () => {
    expect(html).toContain('aria-label="Compartir"');
    expect(html).toContain('aria-label="Compartir por WhatsApp"');
    expect(html).toContain('aria-label="Copiar enlace"');
  });
});
