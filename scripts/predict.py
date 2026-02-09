#!/usr/bin/env python3
"""
Thin prediction script for the Camera Trap Dashboard.

Accepts JSON config via stdin, runs MegaDetector V6 detection + species
classification using pytorch-wildlife, outputs NDJSON to stdout.

Input (stdin JSON):
{
    "image_paths": ["/path/to/img1.jpg", ...],
    "detector_model": "MDV6-yolov9-c",
    "classifier_model": "AI4GAmazonRainforest",
    "device": "cpu",
    "confidence_threshold": 0.1,
    "batch_size": 16
}

Output (stdout NDJSON, one line per message):
{"type": "progress", "image": "/path/to/img1.jpg", "index": 0, "total": 2}
{"type": "result", "image": "/path/to/img1.jpg", "detections": [...]}
{"type": "error", "image": "/path/to/img1.jpg", "message": "..."}
{"type": "complete", "total_processed": 2, "total_detections": 1}
"""

import json
import sys
import os

def emit(msg):
    """Write a JSON line to stdout and flush immediately."""
    print(json.dumps(msg), flush=True)


def run_predictions(config):
    """Run detection + classification pipeline."""
    try:
        import torch
        import numpy as np
        from PIL import Image
        from PytorchWildlife.models import detection as pw_detection
        from PytorchWildlife.models import classification as pw_classification
    except ImportError as e:
        emit({"type": "error", "message": f"Missing dependency: {e}. Install pytorch-wildlife."})
        emit({"type": "complete", "total_processed": 0, "total_detections": 0})
        return

    image_paths = config["image_paths"]
    detector_version = config.get("detector_model", "MDV6-yolov9-c")
    classifier_name = config.get("classifier_model", "AI4GAmazonRainforest")
    device = config.get("device", "cpu")
    confidence_threshold = config.get("confidence_threshold", 0.1)
    batch_size = config.get("batch_size", 16)

    # Auto-detect device
    if device == "auto":
        if torch.cuda.is_available():
            device = "cuda"
        elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            device = "mps"
        else:
            device = "cpu"

    emit({"type": "info", "message": f"Using device: {device}"})

    # Initialize detector
    try:
        emit({"type": "info", "message": f"Loading detector: {detector_version}"})
        detector = pw_detection.MegaDetectorV6(
            device=device,
            pretrained=True,
            version=detector_version
        )
    except Exception as e:
        emit({"type": "error", "message": f"Failed to load detector: {e}"})
        emit({"type": "complete", "total_processed": 0, "total_detections": 0})
        return

    # Initialize classifier
    classifier = None
    try:
        if classifier_name and classifier_name != "none":
            emit({"type": "info", "message": f"Loading classifier: {classifier_name}"})
            # Check if it's a pre-trained model name or a file path
            if os.path.isfile(classifier_name):
                # Custom model - would need class list too
                emit({"type": "info", "message": "Custom classifier not yet supported via web UI"})
            else:
                # Pre-trained model
                classifier_class = getattr(pw_classification, classifier_name, None)
                if classifier_class:
                    try:
                        classifier = classifier_class(device=device)
                    except Exception as e:
                        if device == "mps" and "float64" in str(e):
                            # MPS doesn't support float64 — fall back classifier to CPU
                            emit({"type": "info", "message": f"Classifier failed on MPS ({e}). Retrying on CPU."})
                            classifier = classifier_class(device="cpu")
                            emit({"type": "info", "message": "Classifier loaded on CPU."})
                        else:
                            raise
                else:
                    emit({"type": "info", "message": f"Unknown classifier: {classifier_name}, skipping classification"})
    except Exception as e:
        emit({"type": "info", "message": f"Failed to load classifier: {e}. Continuing with detection only."})

    total = len(image_paths)
    total_detections = 0

    for idx, image_path in enumerate(image_paths):
        emit({"type": "progress", "image": image_path, "index": idx, "total": total})

        try:
            # Run detection on single image
            det_result = detector.single_image_detection(image_path)

            detections_list = []

            if det_result and "detections" in det_result:
                sv_detections = det_result["detections"]

                for i, (xyxy, class_id, conf) in enumerate(zip(
                    sv_detections.xyxy,
                    sv_detections.class_id,
                    sv_detections.confidence
                )):
                    if conf < confidence_threshold:
                        continue

                    # Convert xyxy to normalized xywh
                    # Need image dimensions for normalization
                    img = Image.open(image_path)
                    img_w, img_h = img.size

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

                    # Run classification on animals (class_id 0)
                    if classifier and int(class_id) == 0:
                        try:
                            import supervision as sv
                            cropped = sv.crop_image(
                                image=np.array(Image.open(image_path).convert("RGB")),
                                xyxy=xyxy
                            )
                            clf_result = classifier.single_image_classification(cropped)
                            if clf_result:
                                detection["classification"] = {
                                    "species": clf_result.get("prediction", "Unknown"),
                                    "confidence": round(float(clf_result.get("confidence", 0)), 4),
                                }
                        except Exception as clf_err:
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

        except Exception as e:
            emit({
                "type": "error",
                "image": image_path,
                "message": str(e),
            })

    emit({
        "type": "complete",
        "total_processed": total,
        "total_detections": total_detections,
    })


if __name__ == "__main__":
    try:
        raw = sys.stdin.read()
        config = json.loads(raw)
    except (json.JSONDecodeError, ValueError) as e:
        emit({"type": "error", "message": f"Invalid JSON input: {e}"})
        emit({"type": "complete", "total_processed": 0, "total_detections": 0})
        sys.exit(1)

    run_predictions(config)
