import { describe, it, expect } from "vitest";
import { buildClassifierEnv } from "@/lib/ml-runner-env";
import { ML_DEFAULTS } from "@/lib/ml-defaults";

const validMetrics = {
  modelVersion: "v1",
  trainingDatasetVersion: "v3",
  trainingDatasetContentHash: "sha256:abc",
  backbone: "efficientnet_b0",
  transform: {
    imageSize: 224,
    mean: [0.485, 0.456, 0.406],
    std: [0.229, 0.224, 0.225],
  },
  recommendedConfidenceThreshold: 0.55,
  overall: { top1Accuracy: 0.87, macroF1: 0.81 },
  perClass: {},
  classListOrdered: ["a", "b"],
};

describe("buildClassifierEnv", () => {
  it("falls back to AI4G default when no active model", () => {
    const env = buildClassifierEnv(null);
    expect(env.CLASSIFIER_MODEL).toBe(ML_DEFAULTS.classifierModel);
    expect(env.CUSTOM_CLASSIFIER_WEIGHTS).toBeUndefined();
  });

  it("emits custom_timm env vars when an active model exists", () => {
    const env = buildClassifierEnv({
      id: 7,
      modelDir: "/srv/data/models/v1",
      classMappingJson: JSON.stringify(["a", "b"]),
      metricsJson: JSON.stringify(validMetrics),
    });
    expect(env.CLASSIFIER_MODEL).toBe("custom_timm");
    expect(env.CUSTOM_CLASSIFIER_WEIGHTS).toBe("/srv/data/models/v1/weights.pt");
    expect(env.CUSTOM_CLASSIFIER_CLASS_MAPPING).toBe(
      "/srv/data/models/v1/class_mapping.json",
    );
    expect(env.CUSTOM_CLASSIFIER_BACKBONE).toBe("efficientnet_b0");
    const transform = JSON.parse(env.CUSTOM_CLASSIFIER_TRANSFORM_JSON);
    expect(transform.imageSize).toBe(224);
    expect(transform.mean).toEqual([0.485, 0.456, 0.406]);
    expect(transform.std).toEqual([0.229, 0.224, 0.225]);
  });

  it("defaults legacy models (no interpolation field) to bilinear/squash", () => {
    const env = buildClassifierEnv({
      id: 7,
      modelDir: "/srv/data/models/v1",
      classMappingJson: JSON.stringify(["a", "b"]),
      metricsJson: JSON.stringify(validMetrics),
    });
    const transform = JSON.parse(env.CUSTOM_CLASSIFIER_TRANSFORM_JSON);
    expect(transform.interpolation).toBe("bilinear");
    expect(transform.antialias).toBe(true);
    expect(transform.resize).toBe("squash");
  });

  it("forwards the full preprocessing recipe for EfficientNetV2-M models", () => {
    const v2m = {
      ...validMetrics,
      backbone: "tf_efficientnetv2_m.in21k_ft_in1k",
      transform: {
        imageSize: 480,
        mean: [0.5, 0.5, 0.5],
        std: [0.5, 0.5, 0.5],
        interpolation: "bicubic",
        antialias: true,
        resize: "squash",
      },
    };
    const env = buildClassifierEnv({
      id: 9,
      modelDir: "/srv/data/models/v4",
      classMappingJson: JSON.stringify(["a", "b"]),
      metricsJson: JSON.stringify(v2m),
    });
    const transform = JSON.parse(env.CUSTOM_CLASSIFIER_TRANSFORM_JSON);
    expect(transform.imageSize).toBe(480);
    expect(transform.mean).toEqual([0.5, 0.5, 0.5]);
    expect(transform.interpolation).toBe("bicubic");
    expect(transform.antialias).toBe(true);
    expect(transform.resize).toBe("squash");
  });

  it("derives custom_openclip for a v3/open_clip (BioCLIP) model", () => {
    const bioclip = {
      ...validMetrics,
      contract: { version: "v3" },
      framework: "open_clip",
      backbone: "hf-hub:imageomics/bioclip-2.5-vith14",
      transform: {
        imageSize: 224,
        mean: [0.48145466, 0.4578275, 0.40821073],
        std: [0.26862954, 0.26130258, 0.27577711],
        interpolation: "bicubic",
        antialias: true,
        resize: "squash",
      },
    };
    const env = buildClassifierEnv({
      id: 11,
      modelDir: "/srv/data/models/v4-bioclip",
      classMappingJson: JSON.stringify(["a", "b"]),
      metricsJson: JSON.stringify(bioclip),
    });
    // Single dispatch discriminator derived from framework.
    expect(env.CLASSIFIER_MODEL).toBe("custom_openclip");
    expect(env.CUSTOM_CLASSIFIER_BACKBONE).toBe(
      "hf-hub:imageomics/bioclip-2.5-vith14",
    );
    const transform = JSON.parse(env.CUSTOM_CLASSIFIER_TRANSFORM_JSON);
    expect(transform.imageSize).toBe(224);
    expect(transform.interpolation).toBe("bicubic");
    expect(transform.mean[0]).toBeCloseTo(0.48145466);
  });

  it("treats a model without framework as timm (v2 unchanged)", () => {
    const env = buildClassifierEnv({
      id: 12,
      modelDir: "/srv/data/models/v1",
      classMappingJson: JSON.stringify(["a", "b"]),
      metricsJson: JSON.stringify(validMetrics),
    });
    expect(env.CLASSIFIER_MODEL).toBe("custom_timm");
  });

  it("throws on invalid metrics JSON", () => {
    expect(() =>
      buildClassifierEnv({
        id: 1,
        modelDir: "/m",
        classMappingJson: "[]",
        metricsJson: "{not json",
      }),
    ).toThrow(/invalid metrics\.json/);
  });

  it("throws when backbone missing", () => {
    const broken = { ...validMetrics, backbone: undefined };
    expect(() =>
      buildClassifierEnv({
        id: 1,
        modelDir: "/m",
        classMappingJson: "[]",
        metricsJson: JSON.stringify(broken),
      }),
    ).toThrow(/backbone/);
  });

  it("throws when transform block malformed", () => {
    const broken = { ...validMetrics, transform: { imageSize: 224, mean: [0.5] } };
    expect(() =>
      buildClassifierEnv({
        id: 1,
        modelDir: "/m",
        classMappingJson: "[]",
        metricsJson: JSON.stringify(broken),
      }),
    ).toThrow(/transform/);
  });
});
