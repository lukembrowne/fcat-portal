import { describe, it, expect } from "vitest";
import type { ImageGridItem } from "@/components/image-grid";
import {
  findLastVerifiedId,
  isVerifiedImage,
} from "@/app/camera-trap/results/[id]/resume-helpers";

function img(
  id: number,
  overrides: Partial<ImageGridItem> = {},
): ImageGridItem {
  return {
    id,
    filename: `IMG_${id}.jpg`,
    path: null,
    status: "ok",
    thumbnailPath: null,
    detections: [],
    ...overrides,
  };
}

function detection(status?: string): ImageGridItem["detections"][number] {
  return {
    id: Math.floor(Math.random() * 1e9),
    species: "Puma concolor",
    confidence: 0.9,
    detectionConfidence: 0.95,
    verificationStatus: status,
  };
}

describe("isVerifiedImage", () => {
  it("treats confirmed_blank as verified", () => {
    expect(isVerifiedImage(img(1, { confirmedBlank: true }))).toBe(true);
  });

  it("treats any verified/corrected/rejected detection as verified", () => {
    expect(
      isVerifiedImage(img(1, { detections: [detection("verified")] })),
    ).toBe(true);
    expect(
      isVerifiedImage(img(1, { detections: [detection("corrected")] })),
    ).toBe(true);
    expect(
      isVerifiedImage(img(1, { detections: [detection("rejected")] })),
    ).toBe(true);
  });

  it("treats unverified-only detections as not verified", () => {
    expect(
      isVerifiedImage(img(1, { detections: [detection("unverified")] })),
    ).toBe(false);
  });

  it("treats empty detections without confirmed_blank as not verified", () => {
    expect(isVerifiedImage(img(1))).toBe(false);
  });

  it("verifies when at least one of several detections is verified", () => {
    expect(
      isVerifiedImage(
        img(1, {
          detections: [detection("unverified"), detection("verified")],
        }),
      ),
    ).toBe(true);
  });
});

describe("findLastVerifiedId", () => {
  it("returns null for an empty list", () => {
    expect(findLastVerifiedId([])).toBeNull();
  });

  it("returns null when no images are verified", () => {
    const images = [
      img(1),
      img(2, { detections: [detection("unverified")] }),
      img(3),
    ];
    expect(findLastVerifiedId(images)).toBeNull();
  });

  it("returns the last ID when all images are verified", () => {
    const images = [
      img(1, { confirmedBlank: true }),
      img(2, { detections: [detection("verified")] }),
      img(3, { detections: [detection("corrected")] }),
    ];
    expect(findLastVerifiedId(images)).toBe(3);
  });

  it("finds the rightmost verified image in a mixed list", () => {
    const images = [
      img(1, { detections: [detection("verified")] }),
      img(2, { confirmedBlank: true }), // last verified
      img(3, { detections: [detection("unverified")] }),
      img(4),
      img(5, { detections: [detection("unverified")] }),
    ];
    expect(findLastVerifiedId(images)).toBe(2);
  });

  it("recognizes verified blanks as the resume point", () => {
    const images = [
      img(10),
      img(20, { confirmedBlank: true }),
      img(30, { detections: [detection("unverified")] }),
    ];
    expect(findLastVerifiedId(images)).toBe(20);
  });

  it("handles mixed video frames ordered ascending", () => {
    const images = [
      img(1, { videoId: 100, frameIndex: 0 }),
      img(2, {
        videoId: 100,
        frameIndex: 1,
        detections: [detection("verified")],
      }),
      img(3, { videoId: 100, frameIndex: 2 }), // unverified after last verified frame
      img(4, { videoId: 100, frameIndex: 3, confirmedBlank: true }),
      img(5, { videoId: 100, frameIndex: 4 }),
    ];
    expect(findLastVerifiedId(images)).toBe(4);
  });
});
