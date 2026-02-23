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
    -> {"image_paths": [...], "confidence_threshold": 0.1, "batch_size": 16, "num_workers": 2}\n
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
from concurrent.futures import ThreadPoolExecutor


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


def load_image_safe(image_path):
    """Load a single image from disk. Returns dict with loaded data or error."""
    from PIL import Image
    import numpy as np

    try:
        pil_img = Image.open(image_path).convert("RGB")
        return {
            "path": image_path,
            "array": np.array(pil_img),
            "width": pil_img.size[0],
            "height": pil_img.size[1],
            "error": None,
        }
    except Exception as e:
        return {
            "path": image_path,
            "array": None,
            "width": 0,
            "height": 0,
            "error": str(e),
        }


def process_image(item, detector, classifier, confidence_threshold):
    """Run detection + classification on a single pre-loaded image. Returns (detections_list, error)."""
    import numpy as np

    image_path = item["path"]
    img_w = item["width"]
    img_h = item["height"]
    img_array = item["array"]

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

    return detections_list


def process_job(config, detector, classifier):
    """Process a single job using pre-loaded models. Yields NDJSON messages.

    Images are pre-loaded in parallel using a thread pool (num_workers threads),
    then detection runs sequentially per image within each mini-batch.
    Cancel is checked between batches AND between individual images.
    """
    image_paths = config["image_paths"]
    confidence_threshold = config.get("confidence_threshold", 0.1)
    batch_size = max(1, min(config.get("batch_size", 16), 64))
    num_workers = config.get("num_workers", 0)

    if batch_size != config.get("batch_size", 16):
        emit({"type": "info", "message": f"batch_size clamped to {batch_size}"})

    total = len(image_paths)
    num_batches = (total + batch_size - 1) // batch_size
    total_detections = 0
    processed = 0
    cancelled = False

    emit({"type": "info", "message": f"Job config: {total} images, batch_size={batch_size}, num_workers={num_workers}, {num_batches} batches"})

    for batch_start in range(0, total, batch_size):
        # Check for cancel between batches
        if check_cancel():
            cancelled = True
            break

        batch_paths = image_paths[batch_start:batch_start + batch_size]
        batch_num = batch_start // batch_size + 1

        # Pre-load images in parallel using thread pool
        if num_workers > 0:
            emit({"type": "info", "message": f"Batch {batch_num}/{num_batches}: loading {len(batch_paths)} images with {num_workers} threads"})
            with ThreadPoolExecutor(max_workers=num_workers) as pool:
                loaded_batch = list(pool.map(load_image_safe, batch_paths))
        else:
            emit({"type": "info", "message": f"Batch {batch_num}/{num_batches}: loading {len(batch_paths)} images sequentially"})
            loaded_batch = [load_image_safe(p) for p in batch_paths]

        failed_in_batch = sum(1 for item in loaded_batch if item["error"])
        if failed_in_batch > 0:
            emit({"type": "info", "message": f"Batch {batch_num}: {failed_in_batch}/{len(batch_paths)} images failed to load"})

        # Process each pre-loaded image
        for i, item in enumerate(loaded_batch):
            # Also check cancel between individual images for responsiveness
            if check_cancel():
                cancelled = True
                break

            image_path = item["path"]
            idx = batch_start + i

            # Handle images that failed to load
            if item["error"]:
                emit({
                    "type": "error",
                    "image": image_path,
                    "message": item["error"],
                })
                processed += 1
                continue

            emit({"type": "progress", "image": image_path, "index": idx, "total": total})

            try:
                detections_list = process_image(
                    item, detector, classifier, confidence_threshold
                )

                emit({
                    "type": "result",
                    "image": image_path,
                    "detections": detections_list,
                })
                total_detections += len(detections_list)
                processed += 1

            except Exception as e:
                emit({
                    "type": "error",
                    "image": image_path,
                    "message": str(e),
                })
                processed += 1

        if cancelled:
            break

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
