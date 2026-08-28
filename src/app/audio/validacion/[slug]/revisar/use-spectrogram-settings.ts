"use client";

import { useCallback, useSyncExternalStore } from "react";

import {
  getServerSettingsSnapshot,
  getSettingsSnapshot,
  saveSettings,
  subscribeSettings,
  type ReviewSpectrogramSettings,
} from "./spectrogram-settings";

/**
 * The reviewer's spectrogram settings, read hydration-safely.
 *
 * `useSyncExternalStore` rather than `useState` + an effect: the settings live
 * in localStorage, which the server cannot see, so the first client render must
 * match the server's defaults and only then adopt the stored value. Reading
 * localStorage in a `useState` initializer would produce a hydration mismatch;
 * reading it in an effect and calling `setState` is the same thing with a
 * lint error attached.
 */
export function useReviewSpectrogramSettings(): [
  ReviewSpectrogramSettings,
  (next: ReviewSpectrogramSettings) => void,
] {
  const settings = useSyncExternalStore(
    subscribeSettings,
    getSettingsSnapshot,
    getServerSettingsSnapshot
  );
  // Writes go through localStorage and come back via the event, so two review
  // tabs and the summary line can never disagree about what is in force.
  const update = useCallback((next: ReviewSpectrogramSettings) => saveSettings(next), []);
  return [settings, update];
}
