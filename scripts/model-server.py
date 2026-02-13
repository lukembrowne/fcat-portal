#!/usr/bin/env python3
"""
Persistent model server for Camera Trap ML pipeline.

Loads MegaDetector V6 + classifier ONCE on startup, then accepts
job configs via stdin NDJSON and streams results to stdout.

Protocol:
  Startup:
    <- {"type": "info", "message": "Loading detector: ..."}
    <- {"type": "info", "message": "Loading classifier: ..."}
    <- {"type": "server_ready", "device": "cpu", "detector": "...", "classifier": "..."}

  Per job (repeats):
    -> {"image_paths": [...], "confidence_threshold": 0.1, "batch_size": 16}\n
    <- {"type": "progress", ...}
    <- {"type": "result", ...}
    <- {"type": "complete", "total_processed": N, "total_detections": N}

  Cancel (mid-job):
    -> {"cancel": true}\n
    <- {"type": "complete", ..., "cancelled": true}
"""

import json
import sys
import os
import select


def emit(msg):
    """Write a JSON line to stdout and flush immediately."""
    print(json.dumps(msg), flush=True)


def check_cancel():
    """Non-blocking check if a cancel message has been sent on stdin."""
    ready, _, _ = select.select([sys.stdin], [], [], 0)
    if ready:
        try:
            line = sys.stdin.readline()
            if line:
                msg = json.loads(line.strip())
                if msg.get("cancel"):
                    return True
        except (json.JSONDecodeError, ValueError):
            pass
    return False


def load_models(detector_version, classifier_name, device):
    """Load detector and classifier models. Returns (detector, classifier, device)."""
    import torch
    from PytorchWildlife.models import detection as pw_detection
    from PytorchWildlife.models import classification as pw_classification

    # Auto-detect device
    if device == "auto":
        if torch.cuda.is_available():
            device = "cuda"
        elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            device = "mps"
        else:
            device = "cpu"

    emit({"type": "info", "message": f"Using device: {device}"})

    # Load detector
    emit({"type": "info", "message": f"Loading detector: {detector_version}"})
    detector = pw_detection.MegaDetectorV6(
        device=device,
        pretrained=True,
        version=detector_version,
    )

    # Load classifier
    classifier = None
    classifier_device = device
    if classifier_name and classifier_name != "none":
        emit({"type": "info", "message": f"Loading classifier: {classifier_name}"})
        classifier_class = getattr(pw_classification, classifier_name, None)
        if classifier_class:
            try:
                classifier = classifier_class(device=device)
            except Exception as e:
                if device == "mps" and "float64" in str(e):
                    emit({"type": "info", "message": f"Classifier failed on MPS ({e}). Retrying on CPU."})
                    classifier = classifier_class(device="cpu")
                    classifier_device = "cpu"
                    emit({"type": "info", "message": "Classifier loaded on CPU."})
                else:
                    raise
        else:
            emit({"type": "info", "message": f"Unknown classifier: {classifier_name}, skipping classification"})

    return detector, classifier, device


def process_job(config, detector, classifier):
    """Process a single job using pre-loaded models. Yields NDJSON messages."""
    import numpy as np
    from PIL import Image

    image_paths = config["image_paths"]
    confidence_threshold = config.get("confidence_threshold", 0.1)
    total = len(image_paths)
    total_detections = 0
    processed = 0
    cancelled = False

    for idx, image_path in enumerate(image_paths):
        # Check for cancel between images
        if check_cancel():
            cancelled = True
            break

        emit({"type": "progress", "image": image_path, "index": idx, "total": total})

        try:
            # Load image once — reuse for dimensions and cropping
            pil_img = Image.open(image_path).convert("RGB")
            img_w, img_h = pil_img.size
            img_array = np.array(pil_img)

            # Run detection
            det_result = detector.single_image_detection(image_path)

            detections_list = []

            if det_result and "detections" in det_result:
                sv_detections = det_result["detections"]

                for xyxy, class_id, conf in zip(
                    sv_detections.xyxy,
                    sv_detections.class_id,
                    sv_detections.confidence,
                ):
                    if conf < confidence_threshold:
                        continue

                    x1, y1, x2, y2 = xyxy
                    norm_x = float(x1) / img_w
                    norm_y = float(y1) / img_h
                    norm_w = float(x2 - x1) / img_w
                    norm_h = float(y2 - y1) / img_h

                    detection = {
                        "bbox": {
                            "x": round(norm_x, 4),
                            "y": round(norm_y, 4),
                            "width": round(norm_w, 4),
                            "height": round(norm_h, 4),
                        },
                        "detection_confidence": round(float(conf), 4),
                        "detection_class": int(class_id),
                        "classification": None,
                    }

                    # Classify animals (class_id 0)
                    if classifier and int(class_id) == 0:
                        try:
                            import supervision as sv

                            cropped = sv.crop_image(image=img_array, xyxy=xyxy)
                            clf_result = classifier.single_image_classification(cropped)
                            if clf_result:
                                detection["classification"] = {
                                    "species": clf_result.get("prediction", "Unknown"),
                                    "confidence": round(float(clf_result.get("confidence", 0)), 4),
                                }
                        except Exception:
                            detection["classification"] = {
                                "species": "Unknown",
                                "confidence": 0.0,
                            }

                    detections_list.append(detection)
                    total_detections += 1

            emit({
                "type": "result",
                "image": image_path,
                "detections": detections_list,
            })
            processed += 1

        except Exception as e:
            emit({
                "type": "error",
                "image": image_path,
                "message": str(e),
            })
            processed += 1

    complete_msg = {
        "type": "complete",
        "total_processed": processed,
        "total_detections": total_detections,
    }
    if cancelled:
        complete_msg["cancelled"] = True
    emit(complete_msg)


def main():
    # Default model names — Node.js doesn't send these, they're baked in here
    detector_version = os.environ.get("DETECTOR_MODEL", "MDV6-yolov9-c")
    classifier_name = os.environ.get("CLASSIFIER_MODEL", "AI4GAmazonRainforest")
    device = os.environ.get("ML_DEVICE", "auto")

    try:
        detector, classifier, device = load_models(detector_version, classifier_name, device)
    except Exception as e:
        emit({"type": "error", "message": f"Fatal: failed to load models: {e}"})
        sys.exit(1)

    emit({
        "type": "server_ready",
        "device": device,
        "detector": detector_version,
        "classifier": classifier_name,
    })

    # Job loop — blocks on stdin, waiting for next job config
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            msg = json.loads(line)
        except (json.JSONDecodeError, ValueError):
            emit({"type": "error", "message": f"Invalid JSON: {line[:100]}"})
            continue

        # Cancel messages outside of a job are no-ops
        if msg.get("cancel"):
            continue

        # Must have image_paths to be a valid job
        if "image_paths" not in msg:
            emit({"type": "error", "message": "Missing image_paths in job config"})
            continue

        try:
            process_job(msg, detector, classifier)
        except Exception as e:
            emit({"type": "error", "message": f"Job failed: {e}"})
            emit({"type": "complete", "total_processed": 0, "total_detections": 0})


if __name__ == "__main__":
    main()
