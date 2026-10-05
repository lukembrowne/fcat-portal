/**
 * Keys the download trigger refuses to act on, so a page shortcut is never
 * swallowed by it. Pure for the same reason as `resolveReviewKey`: Vitest has
 * no DOM.
 *
 * Space is play/pause on this page; a Radix trigger would open the menu on it
 * instead (and the page would ALSO toggle playback). The answer keys mean
 * nothing to a button, so they need no guard — only keys a button or the
 * Radix trigger reacts to do. Enter and ↓ still open the menu, so it stays
 * reachable from the keyboard.
 */
export function triggerYieldsKey(key: string): boolean {
  return key === " ";
}
