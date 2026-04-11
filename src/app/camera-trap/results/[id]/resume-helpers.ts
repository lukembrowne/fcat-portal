import type { ImageGridItem } from "@/components/image-grid";

/**
 * An image counts as "verified" once a human has touched it — either
 * confirming it as blank, or marking at least one detection as verified,
 * corrected, or rejected. Used by the "Continuar donde dejé" resume flow
 * to find the boundary between reviewed and unreviewed images.
 */
export function isVerifiedImage(img: ImageGridItem): boolean {
  if (img.confirmedBlank) return true;
  return img.detections.some(
    (d) =>
      d.verificationStatus === "verified" ||
      d.verificationStatus === "corrected" ||
      d.verificationStatus === "rejected",
  );
}

/**
 * Returns the ID of the last verified image in capture-time order, or
 * null if no images are verified.
 *
 * Assumes `images` is already ordered by capture time ascending, which is
 * how the server ships them (see IMAGE_TIMESTAMP_ORDER in src/db/schema.ts
 * and getDeploymentResultsData in src/app/camera-trap/actions.ts). The
 * "last" by array index therefore equals the "last" by capture time — so
 * pressing "Siguiente" from the returned image lands the reviewer on the
 * next image that still needs work.
 */
export function findLastVerifiedId(images: ImageGridItem[]): number | null {
  for (let i = images.length - 1; i >= 0; i--) {
    if (isVerifiedImage(images[i])) return images[i].id;
  }
  return null;
}

/**
 * Scrolls the image grid to the card with the given ID and briefly
 * highlights it. Honors prefers-reduced-motion: no smooth scroll, no
 * pulse animation. Returns true if a target element was found.
 *
 * Safe to call after a filter-reset state update — we wait a frame so
 * the DOM has time to re-render the (possibly previously hidden) card.
 */
export function scrollToImageCard(imageId: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      resolve(false);
      return;
    }
    const reducedMotion = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(
        `[data-image-id="${imageId}"]`,
      );
      if (!el) {
        resolve(false);
        return;
      }
      el.scrollIntoView({
        block: "center",
        behavior: reducedMotion ? "auto" : "smooth",
      });

      const highlightClasses = [
        "ring-4",
        "ring-primary",
        "ring-offset-2",
        "ring-offset-background",
      ];
      el.classList.add(...highlightClasses);
      if (!reducedMotion) el.classList.add("animate-pulse");

      window.setTimeout(() => {
        el.classList.remove(...highlightClasses, "animate-pulse");
      }, 2000);

      resolve(true);
    });
  });
}
