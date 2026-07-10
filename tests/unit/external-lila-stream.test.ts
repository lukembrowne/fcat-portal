import { describe, it, expect, vi, afterEach } from "vitest";
import { zipSync, strToU8 } from "fflate";
import {
  fetchLilaMetadata,
  MD_DETECTOR_VERSION,
  type DatasetConfig,
} from "@/lib/external/lila-source";

/**
 * Exercises the real streaming source path end-to-end against tiny in-memory
 * fixtures: ZIP unzip, the NaN sanitizer, the 3-pass COCO stream, taxonomy
 * resolution, license drop, the precomputed-MD box join (incl. backslash paths),
 * box-less drop, and per-class caps.
 */

const dataset: DatasetConfig = {
  slug: "test",
  name: "Test Dataset",
  metadataUrl: "https://example.org/meta.json.zip",
  mdResultsUrl: "https://example.org/md.json",
  imageBaseUrl: "https://bucket.example.org/test",
  datasetLicense: "CDLA-Permissive-2.0",
};

// COCO metadata. `datetime: NaN` is INVALID JSON on purpose (LILA does this) —
// built via a placeholder we swap for a bare NaN token to defeat JSON.stringify.
const cocoText = JSON.stringify({
  info: { version: 1 },
  images: [
    { id: "i1", file_name: "a/1.jpg", datetime: "__NAN__" },
    { id: "i2", file_name: "b/2.jpg" },
    { id: "i3", file_name: "c/3.jpg" },
    { id: "i4", file_name: "d/4.jpg", license: "CC-BY-NC-4.0" },
    { id: "i5", file_name: "e/5.jpg" },
  ],
  annotations: [
    { image_id: "i1", category_id: 1 }, // ocelot (common name)
    { image_id: "i2", category_id: 1 }, // ocelot, but no animal box -> dropped
    { image_id: "i3", category_id: 3 }, // Mazama americana -> brocket
    { image_id: "i4", category_id: 3 }, // brocket, but NC license -> dropped
    { image_id: "i5", category_id: 2 }, // margay -> unmapped
  ],
  categories: [
    { id: 1, name: "ocelot" },
    { id: 2, name: "margay" },
    { id: 3, name: "Mazama americana" },
    { id: 4, name: "jaguar" },
  ],
}).replace('"__NAN__"', "NaN");

const mdText = JSON.stringify({
  detection_categories: { "1": "animal", "2": "person" },
  images: [
    { file: "a/1.jpg", detections: [{ category: "1", conf: 0.9, bbox: [0.1, 0.1, 0.2, 0.2] }] },
    { file: "b/2.jpg", detections: [{ category: "2", conf: 0.95, bbox: [0, 0, 1, 1] }] }, // person only
    { file: "c\\3.jpg", detections: [{ category: "1", conf: 0.8, bbox: [0.3, 0.3, 0.4, 0.4] }] }, // backslash path
  ],
});

const taxonomyMap = new Map([
  ["ocelot", "Leopardus pardalis"],
  ["margay", "Leopardus wiedii"],
]);

function mockRes(u8: Uint8Array) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    arrayBuffer: async () =>
      u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength),
  } as unknown as Response;
}

afterEach(() => vi.restoreAllMocks());

describe("fetchLilaMetadata (streaming + precomputed boxes)", () => {
  it("streams metadata, tolerates NaN, joins MD boxes, drops box-less + NC", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("meta")) return mockRes(zipSync({ "test.json": strToU8(cocoText) }));
      if (url.includes("md")) return mockRes(strToU8(mdText));
      throw new Error(`unexpected url ${url}`);
    });

    const cap = new Map([
      ["Leopardus pardalis", 5],
      ["Mazama sp.", 5],
    ]);
    const out = await fetchLilaMetadata(dataset, cap, taxonomyMap);

    // i1 (ocelot+box) and i3 (brocket+box via backslash) survive; i2 (no box),
    // i4 (NC license), i5 (unmapped) are dropped.
    expect(out).toHaveLength(2);

    const ocelot = out.find((c) => c.mappedClass === "Leopardus pardalis")!;
    expect(ocelot.sourceImageId).toBe("i1");
    expect(ocelot.bbox).toEqual([0.1, 0.1, 0.2, 0.2]);
    expect(ocelot.detConf).toBe(0.9);
    expect(ocelot.detectorVersion).toBe(MD_DETECTOR_VERSION);
    expect(ocelot.sourceUrl).toBe("https://bucket.example.org/test/a/1.jpg");

    const brocket = out.find((c) => c.mappedClass === "Mazama sp.")!;
    expect(brocket.sourceImageId).toBe("i3");
    expect(brocket.originalTaxon).toBe("Mazama americana");
    expect(brocket.bbox).toEqual([0.3, 0.3, 0.4, 0.4]); // matched despite backslash

    expect(out.find((c) => c.sourceImageId === "i2")).toBeUndefined();
  });

  it("caps per class after the box join", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("meta")) return mockRes(zipSync({ "test.json": strToU8(cocoText) }));
      if (url.includes("md")) return mockRes(strToU8(mdText));
      throw new Error(`unexpected url ${url}`);
    });

    // Cap brocket to 0 (not requested) -> only the ocelot remains.
    const out = await fetchLilaMetadata(dataset, new Map([["Leopardus pardalis", 5]]), taxonomyMap);
    expect(out).toHaveLength(1);
    expect(out[0].mappedClass).toBe("Leopardus pardalis");
  });
});
