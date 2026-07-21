/**
 * Full-bleed layout for the landowner public page (U5 / KTD-5).
 *
 * This route was relocated OUT of the `public/(chrome)` route group so the
 * camera-trap hero can run edge-to-edge to the very top of the viewport,
 * unencumbered by the shared chrome header bar and the `max-w-5xl px-4 py-6`
 * main wrapper. The FCAT/BioChoco wordmark that used to live in the chrome
 * header is folded into the hero scrim overlay (see `public-site-shell.tsx`).
 *
 * Sibling public routes (apply, report, share) stay under `(chrome)` and keep
 * the header/footer. The token URL is unchanged: route groups don't affect it.
 */
export default function LandownerPublicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex flex-col">
      {/* Content renders edge-to-edge: no header, no width cap, no padding. */}
      <main className="flex-1">{children}</main>

      {/* Footer preserved from the (chrome) layout so branding isn't lost. */}
      <footer className="border-t py-4 text-center text-xs text-muted-foreground">
        FCAT (Fundación para la Conservación de los Andes Tropicales)
      </footer>
    </div>
  );
}
