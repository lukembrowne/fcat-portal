/**
 * Plain-text → formatted React nodes for species public content.
 *
 * Authors write a plain `<textarea>`; this renders it "nicely": blank lines
 * become separate paragraphs, and lines starting with "-" or "•" become a
 * bullet list. React escapes all text — no markdown library, no
 * `dangerouslySetInnerHTML`, so there is no injection surface even though this
 * renders on public pages.
 *
 * Shared by the finca showcase row and the fallback per-species page card so
 * both format identically.
 */

import type { ReactNode } from "react";

const BULLET = /^\s*[-•]\s+/;

export function FormatSpeciesContent({ text }: { text: string }): ReactNode {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let bullets: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push(
      <p key={`p${blocks.length}`} className="leading-relaxed">
        {paragraph.map((ln, i) => (
          <span key={i}>
            {i > 0 && <br />}
            {ln}
          </span>
        ))}
      </p>
    );
    paragraph = [];
  };

  const flushBullets = () => {
    if (bullets.length === 0) return;
    blocks.push(
      <ul key={`u${blocks.length}`} className="list-disc space-y-1 pl-5">
        {bullets.map((b, i) => (
          <li key={i} className="leading-relaxed">
            {b}
          </li>
        ))}
      </ul>
    );
    bullets = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.trim() === "") {
      flushParagraph();
      flushBullets();
      continue;
    }
    if (BULLET.test(line)) {
      flushParagraph();
      bullets.push(line.replace(BULLET, ""));
    } else {
      flushBullets();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushBullets();

  return <>{blocks}</>;
}
