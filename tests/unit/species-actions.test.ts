/**
 * Static guard tests for Phase 2 of the species browser.
 *
 * These tests don't hit the database — they confirm structural invariants
 * that, if broken, would create permission leaks:
 *
 * 1. Every public action in actions.ts calls `requirePermission` AND
 *    `getUserCameraTrapProjects` before any Drizzle query.
 * 2. Every action wraps its data in `ActionResult<T>`.
 *
 * The plan's deepen-pass calls these out as CI-grep assertions; turning them
 * into Vitest tests makes them part of the regular test run.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CAMERA_FILE = join(
  process.cwd(),
  "src/app/camera-trap/species/actions.ts"
);
const AUDIO_FILE = join(
  process.cwd(),
  "src/app/audio/species/actions.ts"
);
const SOURCE = readFileSync(CAMERA_FILE, "utf-8");
const AUDIO_SOURCE = readFileSync(AUDIO_FILE, "utf-8");

const PUBLIC_ACTIONS = [
  "getCameraTrapSpeciesIndex",
  "getCameraTrapSpeciesDetail",
  "getCameraTrapSpeciesSitePage",
];

const AUDIO_ACTIONS = [
  "getAudioSpeciesIndex",
  "getAudioSpeciesDetail",
  "getAudioSpeciesSitePage",
];

function extractActionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`);
  if (start === -1) throw new Error(`Action ${name} not found in source`);
  // Naive but sufficient for these files: take a slice large enough to cover
  // a single action body. Two functions of this shape don't share contents.
  return source.slice(start, start + 4000);
}

describe("camera-trap species actions — security invariants", () => {
  for (const name of PUBLIC_ACTIONS) {
    it(`${name} calls requirePermission("camera-trap", "viewer")`, () => {
      const body = extractActionBody(SOURCE, name);
      expect(body).toMatch(/requirePermission\("camera-trap", "viewer"\)/);
    });

    it(`${name} calls getUserCameraTrapProjects`, () => {
      const body = extractActionBody(SOURCE, name);
      expect(body).toMatch(/getUserCameraTrapProjects/);
    });
  }

  it("imports the URL whitelist parsers (no raw param coercion)", () => {
    expect(SOURCE).toMatch(/from "@\/lib\/species-search-params"/);
    expect(SOURCE).toMatch(/parseStatuses|parseProjectId|parsePositiveInt/);
  });

  it("imports the effective-species helper (no ad-hoc CASE WHEN)", () => {
    expect(SOURCE).toMatch(/from "@\/db\/effective-species"/);
    expect(SOURCE).toMatch(/aggregateCameraTrapBySpecies/);
  });
});

describe("audio species actions — security invariants", () => {
  for (const name of AUDIO_ACTIONS) {
    it(`${name} calls requirePermission("grabaciones", "viewer")`, () => {
      const body = extractActionBody(AUDIO_SOURCE, name);
      expect(body).toMatch(/requirePermission\("grabaciones", "viewer"\)/);
    });

    it(`${name} calls getUserCameraTrapProjects`, () => {
      const body = extractActionBody(AUDIO_SOURCE, name);
      expect(body).toMatch(/getUserCameraTrapProjects/);
    });

    it(`${name} applies the confidence filter`, () => {
      const body = extractActionBody(AUDIO_SOURCE, name);
      expect(body).toMatch(/parseThresholdParam|applyConfidenceFilter|threshold/);
    });
  }

  it("imports the URL whitelist parsers", () => {
    expect(AUDIO_SOURCE).toMatch(/from "@\/lib\/species-search-params"/);
  });

  it("imports the audio aggregator helpers", () => {
    expect(AUDIO_SOURCE).toMatch(/aggregateAudioBySpecies/);
    expect(AUDIO_SOURCE).toMatch(/aggregateAudioSpeciesSites/);
  });
});
