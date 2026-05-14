import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  DEFAULT_SETTINGS,
  STORAGE_KEY,
  loadStoredSettings,
  saveStoredSettings,
  migrate,
  normalize,
  type SettingsV1,
  type SettingsV2,
  type SettingsV3,
} from "@/lib/spectrogram-settings";

// ---------------------------------------------------------------------------
// Lightweight in-memory localStorage shim. Vitest runs in node env so
// `window.localStorage` doesn't exist by default; stub it per-test.
// ---------------------------------------------------------------------------
function installLocalStorageShim(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  const shim: Storage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key) {
      return store.get(key) ?? null;
    },
    key(index) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key) {
      store.delete(key);
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
  };
  vi.stubGlobal("window", { localStorage: shim });
  return { store, shim };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// migrate()
// ---------------------------------------------------------------------------
describe("migrate", () => {
  it("upgrades a v1 payload straight to v3 with defaulted new fields", () => {
    const v1: SettingsV1 = {
      version: 1,
      displayMaxHz: 9000,
      gainDB: 18,
      rangeDB: 64,
      fftSize: 2048,
      colormap: "viridis",
    };
    const out = migrate(v1);
    expect(out.version).toBe(3);
    expect(out.zoomLevel).toBe(DEFAULT_SETTINGS.zoomLevel);
    expect(out.followPlayback).toBe(DEFAULT_SETTINGS.followPlayback);
    // v1 fields preserved byte-for-byte
    expect(out.displayMaxHz).toBe(9000);
    expect(out.gainDB).toBe(18);
    expect(out.rangeDB).toBe(64);
    expect(out.fftSize).toBe(2048);
    expect(out.colormap).toBe("viridis");
    // v3 has no spectrogramHeight field at all.
    expect("spectrogramHeight" in out).toBe(false);
  });

  it("upgrades a v2 payload to v3, stripping spectrogramHeight and preserving the rest", () => {
    const v2: SettingsV2 = {
      version: 2,
      displayMaxHz: 15000,
      gainDB: 30,
      rangeDB: 50,
      fftSize: 1024,
      colormap: "turbo",
      spectrogramHeight: "alto",
      zoomLevel: 4,
      followPlayback: false,
    };
    const out = migrate(v2);
    expect(out.version).toBe(3);
    expect("spectrogramHeight" in out).toBe(false);
    expect(out.displayMaxHz).toBe(15000);
    expect(out.gainDB).toBe(30);
    expect(out.colormap).toBe("turbo");
    expect(out.zoomLevel).toBe(4);
    expect(out.followPlayback).toBe(false);
  });

  it("passes a v3 payload through unchanged", () => {
    const v3: SettingsV3 = {
      version: 3,
      displayMaxHz: 12000,
      gainDB: 25,
      rangeDB: 70,
      fftSize: 1024,
      colormap: "magma",
      zoomLevel: 2,
      followPlayback: true,
    };
    expect(migrate(v3)).toEqual(v3);
  });
});

// ---------------------------------------------------------------------------
// normalize()
// ---------------------------------------------------------------------------
describe("normalize", () => {
  it("returns DEFAULT_SETTINGS for non-object input", () => {
    expect(normalize(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalize(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(normalize("hello")).toEqual(DEFAULT_SETTINGS);
    expect(normalize(42)).toEqual(DEFAULT_SETTINGS);
  });

  it("treats missing `version` field as implicit v1 (matches legacy on-disk shape)", () => {
    const legacy = {
      displayMaxHz: 12000,
      gainDB: 25,
      rangeDB: 70,
      fftSize: 1024,
      colormap: "magma",
    };
    const out = normalize(legacy);
    expect(out.version).toBe(1);
  });

  it("preserves a v2 payload's fields including spectrogramHeight so migrate can strip it", () => {
    const out = normalize({
      version: 2,
      displayMaxHz: 6000,
      gainDB: 10,
      rangeDB: 40,
      fftSize: 512,
      colormap: "inferno",
      spectrogramHeight: "alto",
      zoomLevel: 2,
      followPlayback: false,
    });
    expect(out).toMatchObject({
      version: 2,
      spectrogramHeight: "alto",
      zoomLevel: 2,
      followPlayback: false,
      fftSize: 512,
      colormap: "inferno",
    });
  });

  it("preserves a v3 payload's fields", () => {
    const out = normalize({
      version: 3,
      displayMaxHz: 6000,
      gainDB: 10,
      rangeDB: 40,
      fftSize: 512,
      colormap: "inferno",
      zoomLevel: 2,
      followPlayback: false,
    });
    expect(out).toMatchObject({
      version: 3,
      zoomLevel: 2,
      followPlayback: false,
      fftSize: 512,
      colormap: "inferno",
    });
  });

  it("falls back to defaults for invalid individual fields without throwing (v3)", () => {
    const out = normalize({
      version: 3,
      displayMaxHz: "not a number",
      gainDB: NaN,
      rangeDB: 70,
      fftSize: 9999,
      colormap: "not-a-colormap",
      zoomLevel: 3, // not in ZOOM_LEVELS
      followPlayback: "yes",
    });
    expect(out).toMatchObject({
      version: 3,
      displayMaxHz: DEFAULT_SETTINGS.displayMaxHz,
      fftSize: DEFAULT_SETTINGS.fftSize,
      colormap: DEFAULT_SETTINGS.colormap,
      zoomLevel: DEFAULT_SETTINGS.zoomLevel,
      followPlayback: DEFAULT_SETTINGS.followPlayback,
    });
    expect(Number.isNaN(out.gainDB)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// loadStoredSettings + saveStoredSettings (round-trip via localStorage shim)
// ---------------------------------------------------------------------------
describe("loadStoredSettings", () => {
  beforeEach(() => {
    installLocalStorageShim();
  });

  it("returns defaults when localStorage is empty", () => {
    expect(loadStoredSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("returns defaults when stored JSON is malformed", () => {
    window.localStorage.setItem(STORAGE_KEY, "{this isn't json");
    expect(loadStoredSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("migrates legacy (no version field) payload through the chain to v3", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        displayMaxHz: 9000,
        gainDB: 18,
        rangeDB: 64,
        fftSize: 2048,
        colormap: "viridis",
      }),
    );
    const out = loadStoredSettings();
    expect(out.version).toBe(3);
    expect(out.displayMaxHz).toBe(9000);
    expect(out.colormap).toBe("viridis");
    expect("spectrogramHeight" in out).toBe(false);
  });

  it("migrates a stored v2 payload to v3 on load, dropping spectrogramHeight", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        displayMaxHz: 15000,
        gainDB: 30,
        rangeDB: 50,
        fftSize: 1024,
        colormap: "turbo",
        spectrogramHeight: "alto",
        zoomLevel: 4,
        followPlayback: false,
      }),
    );
    const out = loadStoredSettings();
    expect(out.version).toBe(3);
    expect(out.zoomLevel).toBe(4);
    expect(out.followPlayback).toBe(false);
    expect(out.colormap).toBe("turbo");
    expect("spectrogramHeight" in out).toBe(false);
  });

  it("round-trips a saved v3 payload", () => {
    const v3: SettingsV3 = {
      ...DEFAULT_SETTINGS,
      colormap: "inferno",
      zoomLevel: 4,
    };
    saveStoredSettings(v3);
    expect(loadStoredSettings()).toEqual(v3);
  });
});

describe("saveStoredSettings", () => {
  it("silently no-ops if localStorage.setItem throws (quota / private mode)", () => {
    const setItem = vi.fn(() => {
      throw new Error("QuotaExceededError");
    });
    vi.stubGlobal("window", {
      localStorage: { setItem, getItem: () => null } as unknown as Storage,
    });
    expect(() => saveStoredSettings(DEFAULT_SETTINGS)).not.toThrow();
    expect(setItem).toHaveBeenCalledOnce();
  });
});
