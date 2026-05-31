import { describe, it, expect } from "vitest";
import {
  MetricsV2Schema,
  looksLikeV1Contract,
} from "@/app/camera-trap/models/metrics-schema";

const baseV2 = {
  contract: { version: "v2" as const },
  modelVersion: "v4",
  trainingDatasetVersion: "v4",
  trainingDatasetContentHash: "sha256:abc",
  backbone: "tf_efficientnetv2_m.in21k_ft_in1k",
  transform: {
    imageSize: 480,
    mean: [0.5, 0.5, 0.5],
    std: [0.5, 0.5, 0.5],
    interpolation: "bicubic" as const,
    antialias: true,
    resize: "squash" as const,
  },
  recommendedConfidenceThreshold: 0.55,
  overall: { top1Accuracy: 0.6, macroF1: 0.45 },
  perClass: {},
  classListOrdered: ["a", "b"],
};

const v3 = {
  ...baseV2,
  contract: { version: "v3" as const },
  framework: "open_clip" as const,
  frameworkVersion: "open_clip==2.32.0",
  weightsSha256: "sha256:deadbeef",
  backbone: "hf-hub:imageomics/bioclip-2.5-vith14",
  transform: {
    imageSize: 224,
    mean: [0.48145466, 0.4578275, 0.40821073],
    std: [0.26862954, 0.26130258, 0.27577711],
    interpolation: "bicubic" as const,
    antialias: true,
    resize: "squash" as const,
  },
};

describe("MetricsV2Schema", () => {
  it("accepts a v2/timm artifact (framework absent)", () => {
    expect(MetricsV2Schema.safeParse(baseV2).success).toBe(true);
  });

  it("accepts a v3/open_clip artifact", () => {
    const parsed = MetricsV2Schema.safeParse(v3);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.framework).toBe("open_clip");
      expect(parsed.data.weightsSha256).toBe("sha256:deadbeef");
    }
  });

  // The fail-safe's load-bearing guard: the version<->framework biconditional.
  it("rejects v3 + timm (missing framework defaults to timm)", () => {
    const bad = { ...v3, framework: undefined };
    const parsed = MetricsV2Schema.safeParse(bad);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0].path).toContain("framework");
    }
  });

  it("rejects v3 + explicit timm framework", () => {
    const bad = { ...v3, framework: "timm" as const };
    expect(MetricsV2Schema.safeParse(bad).success).toBe(false);
  });

  it("rejects v2 + open_clip framework", () => {
    const bad = { ...baseV2, framework: "open_clip" as const };
    expect(MetricsV2Schema.safeParse(bad).success).toBe(false);
  });

  it("rejects an unknown contract version", () => {
    const bad = { ...baseV2, contract: { version: "v9" } };
    expect(MetricsV2Schema.safeParse(bad).success).toBe(false);
  });

  it("looksLikeV1Contract flags legacy, not v2/v3", () => {
    expect(looksLikeV1Contract({ contractVersion: "v1" })).toBe(true);
    expect(looksLikeV1Contract(baseV2)).toBe(false);
    expect(looksLikeV1Contract(v3)).toBe(false);
  });
});
