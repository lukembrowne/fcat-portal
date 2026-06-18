/**
 * Locks the routing contract the Field Uploader depends on: subfolder names and
 * the extension→subfolder mapping. If anyone changes `drive-routing.ts`, this
 * test forces a conscious update (and the endpoint ships the new config to the
 * app with no release).
 */

import { describe, it, expect } from "vitest";
import {
  buildRoutingConfig,
  DATA_TYPE_FOLDERS,
  AUDIO_CALIBRATION_FOLDER,
  AUDIO_EXTENSIONS,
} from "@/lib/drive-routing";

describe("drive-routing", () => {
  it("exposes the exact Drive subfolder names", () => {
    expect(DATA_TYPE_FOLDERS).toEqual({
      camarasTrampas: "camaras_trampas",
      grabadoresDeAudio: "grabadores_de_audio",
      ibutton: "ibutton",
    });
  });

  it("exposes the audio-calibration folder name, kept OUT of the routing contract", () => {
    expect(AUDIO_CALIBRATION_FOLDER).toBe("calibracion_de_audio");
    // It must NOT leak into the field-uploader routing config.
    expect(Object.values(buildRoutingConfig().subfolders)).not.toContain(
      AUDIO_CALIBRATION_FOLDER,
    );
  });

  it("builds the routing config with the three subfolders", () => {
    const cfg = buildRoutingConfig();
    expect(cfg.subfolders).toEqual({
      camera: "camaras_trampas",
      audio: "grabadores_de_audio",
      ibutton: "ibutton",
    });
  });

  it("routes images + video into the camera folder", () => {
    const { camera } = buildRoutingConfig().extensions;
    for (const ext of [".jpg", ".jpeg", ".png", ".tiff", ".mp4", ".avi", ".mov"]) {
      expect(camera).toContain(ext);
    }
    // No audio extension leaks into the camera group.
    expect(camera).not.toContain(".wav");
  });

  it("routes audio extensions (incl. flac) into the audio folder", () => {
    const { audio } = buildRoutingConfig().extensions;
    expect([...audio].sort()).toEqual([...AUDIO_EXTENSIONS].sort());
    expect(audio).toContain(".wav");
    expect(audio).toContain(".flac");
  });

  it("routes only .xlsx into the ibutton folder", () => {
    expect(buildRoutingConfig().extensions.ibutton).toEqual([".xlsx"]);
  });

  it("returns sorted, stable extension arrays", () => {
    const a = buildRoutingConfig().extensions.camera;
    expect(a).toEqual([...a].sort());
  });
});
