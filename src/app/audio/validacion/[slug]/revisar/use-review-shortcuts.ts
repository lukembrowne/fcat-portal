/**
 * Keyboard intent resolution for the validation review queue.
 *
 * The resolver is a PURE function, separate from the hook, because Vitest runs
 * in a `node` environment with no DOM — a pure resolver is the only way to
 * cover the keymap without pulling in jsdom. Same constraint that shaped
 * `resolveDigitKeyAction` in the camera-trap annotation shortcuts.
 */

import { useEffect, useRef } from "react";

export type ReviewIntent =
  | { kind: "answer"; outcome: "correct" | "incorrect" | "uncertain" }
  | { kind: "toggle" }
  | { kind: "replay" }
  | { kind: "back" }
  | { kind: "skip" }
  | null;

export interface KeyContext {
  /** True when focus sits in a text input — all shortcuts are suppressed. */
  inEditableField: boolean;
  /**
   * True when focus sits inside the `<audio controls>` element.
   *
   * The browser already binds space and the arrows on a focused media control,
   * and `preventDefault` on keydown does not stop its shadow-DOM buttons, which
   * activate on keyup. Handling those keys here as well fires both — which is
   * why the keyboard starts behaving differently the moment someone clicks the
   * player. Transport keys yield; the answer keys mean nothing to a media
   * element and keep working.
   */
  inMediaControl: boolean;
  /** Position in the queue; `back` is a no-op at the start. */
  index: number;
}

/**
 * Map a key to an intent.
 *
 * Two bindings per answer so a reviewer can use either the number row or the
 * Spanish-mnemonic letters (sí / no / no sé) without relearning.
 *
 * Space is play/pause, matching every media player. It used to be replay, which
 * meant a second press restarted the clip instead of stopping it; replay moved
 * to `r`.
 */
export function resolveReviewKey(key: string, ctx: KeyContext): ReviewIntent {
  if (ctx.inEditableField) return null;

  switch (key) {
    case "1":
    case "s":
    case "S":
      return { kind: "answer", outcome: "correct" };
    case "2":
    case "n":
    case "N":
      return { kind: "answer", outcome: "incorrect" };
    case "3":
    case "u":
    case "U":
      return { kind: "answer", outcome: "uncertain" };
    case " ":
      return ctx.inMediaControl ? null : { kind: "toggle" };
    case "r":
    case "R":
      return ctx.inMediaControl ? null : { kind: "replay" };
    case "ArrowLeft":
      if (ctx.inMediaControl) return null;
      return ctx.index > 0 ? { kind: "back" } : null;
    case "ArrowRight":
      return ctx.inMediaControl ? null : { kind: "skip" };
    default:
      return null;
  }
}

/** True when the event target is a field where typing should win over shortcuts. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

/**
 * True when the event came from the audio player's own controls.
 *
 * A keypress on a shadow-DOM control reports the host `<audio>` element as its
 * target, so checking the tag name is enough — there is no shadow boundary to
 * pierce.
 */
export function isMediaTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.tagName === "AUDIO";
}

export interface ReviewShortcutHandlers {
  onAnswer: (outcome: "correct" | "incorrect" | "uncertain") => void;
  onToggle: () => void;
  onReplay: () => void;
  onBack: () => void;
  onSkip: () => void;
}

/**
 * Bind the review keymap for as long as the component is mounted.
 *
 * Handlers are held in a ref so a re-render (which happens on every answer)
 * does not tear down and re-add the listener mid-keystroke.
 */
export function useReviewShortcuts(
  index: number,
  handlers: ReviewShortcutHandlers,
  enabled: boolean
): void {
  const handlersRef = useRef(handlers);
  const indexRef = useRef(index);

  // Synced in an effect, not during render: writing a ref while rendering is
  // unsafe under concurrent React, which may render without committing.
  useEffect(() => {
    handlersRef.current = handlers;
    indexRef.current = index;
  }, [handlers, index]);

  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (event: KeyboardEvent) => {
      const intent = resolveReviewKey(event.key, {
        inEditableField: isEditableTarget(event.target),
        inMediaControl: isMediaTarget(event.target),
        index: indexRef.current,
      });
      if (!intent) return;

      // Space scrolls the page by default, and the arrows move the caret.
      event.preventDefault();

      const h = handlersRef.current;
      switch (intent.kind) {
        case "answer":
          h.onAnswer(intent.outcome);
          break;
        case "toggle":
          h.onToggle();
          break;
        case "replay":
          h.onReplay();
          break;
        case "back":
          h.onBack();
          break;
        case "skip":
          h.onSkip();
          break;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}
