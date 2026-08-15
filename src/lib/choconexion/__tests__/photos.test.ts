import { describe, it, expect, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

import {
  MAX_PHOTOS_PER_SITE,
  exportSitePhotos,
  rankPhotoCandidates,
  resolveTakenAt,
  spreadEvenly,
  takenAtDate,
  type PhotoCandidate,
} from "../photos";

let nextId = 1000;
const candidate = (over: Partial<PhotoCandidate> = {}): PhotoCandidate => ({
  imageId: nextId++,
  driveFileId: `drive-${nextId}`,
  starred: false,
  species: null,
  takenAtEpoch: 1_777_112_988,
  ...over,
});

/** A tiny real JPEG, so the sharp path is exercised rather than mocked. */
async function tinyJpeg(): Promise<Buffer> {
  return sharp({
    create: { width: 64, height: 48, channels: 3, background: { r: 20, g: 90, b: 40 } },
  })
    .jpeg()
    .toBuffer();
}

describe("takenAtDate", () => {
  it("formats in Ecuador local time, not UTC", () => {
    // 2026-03-25 20:30 Ecuador == 2026-03-26 01:30 UTC. Formatting the instant
    // with UTC getters would date this nocturnal frame to the following day.
    const epoch = Date.parse("2026-03-26T01:30:00Z") / 1000;
    expect(takenAtDate(epoch)).toBe("2026-03-25");
  });

  it("keeps a midday frame on its own day", () => {
    const epoch = Date.parse("2026-03-25T17:00:00Z") / 1000; // 12:00 Ecuador
    expect(takenAtDate(epoch)).toBe("2026-03-25");
  });

  it("returns null for a missing or non-finite timestamp", () => {
    expect(takenAtDate(null)).toBeNull();
    expect(takenAtDate(NaN)).toBeNull();
  });
});

describe("resolveTakenAt", () => {
  it("falls back to file_modified when there is no EXIF", () => {
    // The dateless-filename cameras at these sites carry no EXIF at all.
    expect(resolveTakenAt(null, 1_777_112_988)).toBe(1_777_112_988);
  });

  it("returns null when neither is present", () => {
    expect(resolveTakenAt(null, null)).toBeNull();
  });

  it("ignores an unparseable EXIF value rather than throwing", () => {
    expect(resolveTakenAt("not a timestamp", 1_777_112_988)).toBe(1_777_112_988);
  });
});

describe("spreadEvenly", () => {
  it("returns everything when the count meets the length", () => {
    expect(spreadEvenly([1, 2, 3], 5)).toEqual([1, 2, 3]);
  });

  it("spreads across the range instead of taking the head", () => {
    expect(spreadEvenly([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3)).toEqual([1, 4, 7]);
  });

  it("always includes the first item", () => {
    expect(spreadEvenly([1, 2, 3, 4], 1)).toEqual([1]);
  });

  it("returns nothing for a non-positive count", () => {
    expect(spreadEvenly([1, 2, 3], 0)).toEqual([]);
  });
});

describe("rankPhotoCandidates", () => {
  it("leads with starred frames", () => {
    const plain = [candidate(), candidate(), candidate()];
    const star = candidate({ starred: true, species: "Nasua narica" });
    const picked = rankPhotoCandidates([...plain, star]);
    expect(picked[0].imageId).toBe(star.imageId);
  });

  it("caps at eight even with many candidates", () => {
    const many = Array.from({ length: 40 }, () =>
      candidate({ species: "Dasyprocta punctata" }),
    );
    expect(rankPhotoCandidates(many)).toHaveLength(MAX_PHOTOS_PER_SITE);
  });

  it("exceeds the cap rather than leave a species with no example frame", () => {
    // P16 in production: eleven species, eight slots. The viewer renders a
    // thumbnail beside every species name, so a species with no frame reads as
    // missing data. Coverage wins over the cap.
    const species = Array.from({ length: 11 }, (_, i) => `Species ${i}`);
    const pool = species.flatMap((s) =>
      Array.from({ length: 4 }, () => candidate({ species: s })),
    );

    const picked = rankPhotoCandidates(pool);

    expect(picked).toHaveLength(11);
    expect(new Set(picked.map((p) => p.species))).toEqual(new Set(species));
  });

  it("still honours the cap when species fit inside it", () => {
    const pool = ["a", "b", "c"].flatMap((s) =>
      Array.from({ length: 10 }, () => candidate({ species: s })),
    );
    expect(rankPhotoCandidates(pool)).toHaveLength(MAX_PHOTOS_PER_SITE);
  });

  it("covers every species even when starred frames have eaten the budget", () => {
    // The real P16 shape: eleven species, three starred frames, and abundance
    // that falls off a cliff. Sizing the budget before the starred pass — or
    // leaving the round-robin in abundance order — spends the slots on more
    // agoutis and leaves the single tamandua with no example frame.
    const abundance = { agouti: 94, armadillo: 21, paca: 11, peccary: 10 };
    const pool = [
      ...Object.entries(abundance).flatMap(([s, n]) =>
        Array.from({ length: n }, () => candidate({ species: s })),
      ),
      ...["tayra", "opossum", "ocelot", "guan", "raccoon", "spinyrat", "tamandua"]
        .flatMap((s) => Array.from({ length: 3 }, () => candidate({ species: s }))),
    ];
    pool[0].starred = true;
    pool[1].starred = true;
    pool[2].starred = true;

    const picked = rankPhotoCandidates(pool);

    const represented = new Set(picked.map((p) => p.species));
    expect([...represented].sort()).toEqual(
      [...new Set(pool.map((p) => p.species))].sort(),
    );
    expect(picked.map((p) => p.imageId)).toHaveLength(new Set(picked.map((p) => p.imageId)).size);
  });

  it("takes three starred frames first, then fills to eight", () => {
    const starred = Array.from({ length: 3 }, () => candidate({ starred: true }));
    const identified = Array.from({ length: 9 }, () =>
      candidate({ species: "Dasyprocta punctata" }),
    );
    const picked = rankPhotoCandidates([...identified, ...starred]);

    expect(picked).toHaveLength(8);
    expect(picked.slice(0, 3).every((p) => p.starred)).toBe(true);
  });

  it("includes the rare species rather than eight frames of the abundant one", () => {
    // The failure this exists to prevent: 40 agouti frames crowding out the
    // single ocelot frame at the same site.
    const abundant = Array.from({ length: 40 }, () =>
      candidate({ species: "Dasyprocta punctata" }),
    );
    const rare = candidate({ species: "Leopardus pardalis" });
    const picked = rankPhotoCandidates([...abundant, rare]);

    expect(picked.map((p) => p.species)).toContain("Leopardus pardalis");
  });

  it("gives every species a frame before any species gets a second", () => {
    const build = (species: string, n: number) =>
      Array.from({ length: n }, () => candidate({ species }));
    const picked = rankPhotoCandidates([
      ...build("A", 10),
      ...build("B", 10),
      ...build("C", 10),
    ]);

    const firstThree = picked.slice(0, 3).map((p) => p.species);
    expect(new Set(firstThree).size).toBe(3);
  });

  it("spreads within a species instead of taking a consecutive burst", () => {
    // REF-007's real shape: consecutive ids seconds apart, same animal.
    const burst = Array.from({ length: 20 }, (_, i) => ({
      ...candidate({ species: "Dasypus fenestratus" }),
      imageId: 154_643 + i,
    }));
    const picked = rankPhotoCandidates(burst, 4);

    const ids = picked.map((p) => p.imageId).sort((a, b) => a - b);
    const gaps = ids.slice(1).map((id, i) => id - ids[i]);
    expect(gaps.every((g) => g > 1)).toBe(true);
  });

  it("ships fewer than eight when few frames qualify, with no padding", () => {
    const picked = rankPhotoCandidates([
      candidate({ species: "Nasua narica" }),
      candidate({ species: "Nasua narica" }),
      candidate({ species: "Eira barbara" }),
    ]);
    expect(picked).toHaveLength(3);
  });

  it("returns nothing when no candidate has a Drive file", () => {
    const picked = rankPhotoCandidates([
      candidate({ driveFileId: null, starred: true }),
      candidate({ driveFileId: null, species: "Nasua narica" }),
    ]);
    expect(picked).toEqual([]);
  });

  it("returns nothing for a site with no candidates at all", () => {
    expect(rankPhotoCandidates([])).toEqual([]);
  });

  it("does not select frames that are neither starred nor identified", () => {
    // A no-species site has processed images and nothing confirmed in any of
    // them. It ships no strip rather than a strip of empty forest, since the
    // ranking only admits a human star or a confirmed identification.
    const picked = rankPhotoCandidates(
      Array.from({ length: 20 }, () => candidate()),
    );
    expect(picked).toEqual([]);
  });

  it("keeps a starred frame eligible even when its label is a bucket class", () => {
    // The species field arrives null for a bucket-class or domestic label; the
    // star is an independent human signal and still qualifies the frame.
    const starredUnidentified = candidate({ starred: true, species: null });
    expect(rankPhotoCandidates([starredUnidentified]).map((p) => p.imageId)).toEqual([
      starredUnidentified.imageId,
    ]);
  });

  it("excludes unidentified frames when identified ones are available", () => {
    const identified = Array.from({ length: 8 }, () =>
      candidate({ species: "Nasua narica" }),
    );
    const unidentified = Array.from({ length: 8 }, () => candidate());
    const picked = rankPhotoCandidates([...unidentified, ...identified]);

    expect(picked.every((p) => p.species === "Nasua narica")).toBe(true);
  });

  it("is deterministic across runs", () => {
    const pool = [
      candidate({ species: "A", starred: true }),
      ...Array.from({ length: 15 }, () => candidate({ species: "B" })),
      ...Array.from({ length: 15 }, () => candidate({ species: "C" })),
    ];
    const once = rankPhotoCandidates(pool).map((p) => p.imageId);
    const twice = rankPhotoCandidates([...pool].reverse()).map((p) => p.imageId);
    expect(once).toEqual(twice);
  });

  it("never returns the same frame twice", () => {
    const starred = candidate({ starred: true, species: "Nasua narica" });
    const picked = rankPhotoCandidates([
      starred,
      starred,
      ...Array.from({ length: 10 }, () => candidate({ species: "Nasua narica" })),
    ]);
    expect(new Set(picked.map((p) => p.imageId)).size).toBe(picked.length);
  });
});

describe("exportSitePhotos", () => {
  const withTempDir = async (fn: (dir: string) => Promise<void>) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chocon-photos-"));
    try {
      await fn(dir);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  };

  it("writes both sizes and records their public paths", async () => {
    await withTempDir(async (dir) => {
      const jpeg = await tinyJpeg();
      const result = await exportSitePhotos({
        siteCode: "REF-007",
        candidates: [candidate({ imageId: 42, species: "Nasua narica" })],
        outDir: dir,
        publicPrefix: "sites/REF-007/photos",
        fetchImage: async () => jpeg,
      });

      expect(result.photos).toHaveLength(1);
      expect(result.photos[0]).toMatchObject({
        imageId: 42,
        strip: "sites/REF-007/photos/42-strip.webp",
        full: "sites/REF-007/photos/42-full.webp",
        species: "Nasua narica",
      });

      const written = await fs.readdir(dir);
      expect(written.sort()).toEqual(["42-full.webp", "42-strip.webp"]);
    });
  });

  it("produces real WebP files, with the strip smaller than the enlarged size", async () => {
    await withTempDir(async (dir) => {
      // A large source, so the two widths actually differ after resize.
      const big = await sharp({
        create: { width: 2400, height: 1600, channels: 3, background: { r: 10, g: 80, b: 30 } },
      })
        .jpeg()
        .toBuffer();

      await exportSitePhotos({
        siteCode: "REF-007",
        candidates: [candidate({ imageId: 7, starred: true })],
        outDir: dir,
        publicPrefix: "p",
        fetchImage: async () => big,
      });

      const strip = await sharp(path.join(dir, "7-strip.webp")).metadata();
      const full = await sharp(path.join(dir, "7-full.webp")).metadata();

      expect(strip.format).toBe("webp");
      expect(full.format).toBe("webp");
      expect(strip.width).toBe(480);
      expect(full.width).toBe(1400);
    });
  });

  it("drops a frame whose fetch fails and keeps the rest", async () => {
    await withTempDir(async (dir) => {
      const jpeg = await tinyJpeg();
      const fetchImage = vi
        .fn()
        .mockRejectedValueOnce(new Error("drive 404"))
        .mockResolvedValue(jpeg);

      const result = await exportSitePhotos({
        siteCode: "REF-007",
        candidates: [
          candidate({ imageId: 1, starred: true }),
          candidate({ imageId: 2, starred: true }),
        ],
        outDir: dir,
        publicPrefix: "p",
        fetchImage,
      });

      expect(result.photos).toHaveLength(1);
      expect(result.photos[0].imageId).toBe(2);
      expect(result.warnings[0]).toContain("REF-007");
      expect(result.warnings[0]).toContain("drive 404");
    });
  });

  it("does not fetch anything for a site with no qualifying frames", async () => {
    await withTempDir(async (dir) => {
      const fetchImage = vi.fn();
      const result = await exportSitePhotos({
        siteCode: "SEC-002",
        candidates: [],
        outDir: dir,
        publicPrefix: "p",
        fetchImage,
      });

      expect(result.photos).toEqual([]);
      expect(fetchImage).not.toHaveBeenCalled();
    });
  });

  it("records the capture date on each frame", async () => {
    await withTempDir(async (dir) => {
      const jpeg = await tinyJpeg();
      const result = await exportSitePhotos({
        siteCode: "REF-007",
        candidates: [
          candidate({
            imageId: 9,
            starred: true,
            takenAtEpoch: Date.parse("2026-03-25T17:00:00Z") / 1000,
          }),
        ],
        outDir: dir,
        publicPrefix: "p",
        fetchImage: async () => jpeg,
      });

      expect(result.photos[0].takenAt).toBe("2026-03-25");
    });
  });
});
