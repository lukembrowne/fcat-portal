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
import time
from concurrent.futures import ThreadPoolExecutor

# Cap native thread pools BEFORE any numpy / torch / OpenMP / MKL imports.
# These are also set on the spawn env in src/lib/ml-runner.ts (the load-bearing place
# — native libs read them at .so load time). The setdefault here is defense-in-depth
# in case this script is invoked outside the Node spawn path.
# Default: (cpu_count - 1) to leave one core free for the rest of the system.
_default_thread_cap = str(max(1, (os.cpu_count() or 2) - 1))
os.environ.setdefault("OMP_NUM_THREADS", _default_thread_cap)
os.environ.setdefault("MKL_NUM_THREADS", _default_thread_cap)
os.environ.setdefault("OPENBLAS_NUM_THREADS", _default_thread_cap)
os.environ.setdefault("NUMEXPR_NUM_THREADS", _default_thread_cap)


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

    # Cap PyTorch's intra-op + inter-op pools. set_num_interop_threads MUST be called
    # before any parallel work has started — load_models is the only safe place.
    # Respect OMP_NUM_THREADS (set by ml-runner.ts spawn env or our setdefault above)
    # so all four limits agree. Falls back to (cpu_count - 1).
    _torch_threads = int(
        os.environ.get("OMP_NUM_THREADS") or max(1, (os.cpu_count() or 2) - 1)
    )
    torch.set_num_threads(_torch_threads)
    emit({"type": "info", "message": f"PyTorch thread cap: {_torch_threads} (cpu_count={os.cpu_count()})"})
    try:
        torch.set_num_interop_threads(1)
    except RuntimeError:
        # Already initialized — only happens if load_models is called twice in one process.
        pass

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

        # Custom Chocó classifier — fine-tuned timm model whose weights and
        # transform live in data/models/<version>/. The portal passes the paths
        # via env vars set by ml-runner.ts/buildClassifierEnv. Loaded with
        # strict=True so any class-mapping or backbone drift fails loudly.
        if classifier_name == "custom_timm":
            try:
                classifier = TimmClassifier.from_env(device=device)
                emit({"type": "info", "message": f"Loaded custom_timm ({classifier.backbone}, {len(classifier.class_list)} classes) on {device}"})
            except Exception as e:
                emit({"type": "info", "message": f"custom_timm load failed: {e}"})
                raise
        elif classifier_name == "custom_openclip":
            try:
                classifier = OpenClipClassifier.from_env(device=device)
                emit({"type": "info", "message": f"Loaded custom_openclip ({classifier.backbone}, {len(classifier.class_list)} classes) on {device}"})
            except Exception as e:
                emit({"type": "info", "message": f"custom_openclip load failed: {e}"})
                raise
        else:
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


def _custom_classifier_env():
    """Read + validate the four CUSTOM_CLASSIFIER_* env vars (shared by both paths)."""
    weights_path = os.environ.get("CUSTOM_CLASSIFIER_WEIGHTS")
    class_mapping_path = os.environ.get("CUSTOM_CLASSIFIER_CLASS_MAPPING")
    backbone = os.environ.get("CUSTOM_CLASSIFIER_BACKBONE")
    transform_json = os.environ.get("CUSTOM_CLASSIFIER_TRANSFORM_JSON")
    if not (weights_path and class_mapping_path and backbone and transform_json):
        raise RuntimeError(
            "custom classifier requires CUSTOM_CLASSIFIER_{WEIGHTS,CLASS_MAPPING,BACKBONE,TRANSFORM_JSON}"
        )
    return weights_path, class_mapping_path, backbone, transform_json


def _load_class_list(class_mapping_path):
    import json as _json
    with open(class_mapping_path, "r") as f:
        class_list = _json.load(f)
    if not isinstance(class_list, list) or not all(isinstance(s, str) for s in class_list):
        raise RuntimeError(
            f"class_mapping.json must be a list of strings, got: {type(class_list).__name__}"
        )
    return class_list


def _build_eval_transform(transform_cfg):
    """Build the torchvision eval transform from a CUSTOM_CLASSIFIER_TRANSFORM_JSON dict.

    Shared by the timm (v2) and open_clip (v3) paths — both drive preprocessing
    entirely from the self-describing transform block. Must match the classifier
    repo's data.build_transforms exactly (interpolation/antialias/resize) or
    accuracy silently drops. interpolation/antialias/resize are additive
    (contract v2.1+); models registered before they existed default to
    bilinear/on/squash, so legacy efficientnet_b0 @ 224 models are unaffected.
    BioCLIP (v3) carries bicubic + CLIP mean/std + squash @ 224 explicitly.
    """
    from torchvision import transforms
    from torchvision.transforms import InterpolationMode

    image_size = int(transform_cfg["imageSize"])
    mean = list(transform_cfg["mean"])
    std = list(transform_cfg["std"])
    _interp_modes = {
        "bilinear": InterpolationMode.BILINEAR,
        "bicubic": InterpolationMode.BICUBIC,
        "nearest": InterpolationMode.NEAREST,
    }
    interp_name = transform_cfg.get("interpolation", "bilinear")
    if interp_name not in _interp_modes:
        raise RuntimeError(f"unknown interpolation {interp_name!r}")
    interpolation = _interp_modes[interp_name]
    antialias = bool(transform_cfg.get("antialias", True))
    resize_mode = transform_cfg.get("resize", "squash")
    if resize_mode != "squash":
        raise RuntimeError(
            f"unsupported resize mode {resize_mode!r} (only 'squash' is implemented)"
        )
    return transforms.Compose([
        transforms.ToPILImage(),
        transforms.Resize(
            (image_size, image_size),
            interpolation=interpolation,
            antialias=antialias,
        ),
        transforms.ToTensor(),
        transforms.Normalize(mean=mean, std=std),
    ])


def _check_free_disk(min_gb, probe_path=None):
    """Fail fast if the box can't hold the HF cache + weights for reconstruction.

    Building a BioCLIP arch downloads the ~2.5 GB hub checkpoint (overwritten by
    the strict load) into the HF cache, on top of the ~2.5 GB weights.pt already
    on disk. A mid-download disk-full leaves a corrupt cache and an opaque error;
    this surfaces it cleanly instead.
    """
    import shutil

    if probe_path is None:
        probe_path = os.environ.get("HF_HOME") or os.path.expanduser("~")
    # Walk up to the nearest existing ancestor (HF_HOME may not exist yet).
    while probe_path and not os.path.exists(probe_path):
        parent = os.path.dirname(probe_path)
        if parent == probe_path:
            break
        probe_path = parent
    free_gb = shutil.disk_usage(probe_path).free / (1024 ** 3)
    if free_gb < min_gb:
        raise RuntimeError(
            f"insufficient free disk for open_clip reconstruction: "
            f"{free_gb:.1f} GB free at {probe_path}, need ~{min_gb} GB (HF cache + weights)"
        )


class _CropClassifier:
    """Shared crop-classifier wrapper: a model + ordered class list + eval transform.

    Matches the PytorchWildlife classifier protocol used by detections_from_result:
    ``single_image_classification(cropped_array) -> {"prediction": str, "confidence": float}``.
    Subclasses (TimmClassifier, OpenClipClassifier) differ ONLY in how ``from_env``
    reconstructs the model; the transform, classify, and contract are identical.
    """

    def __init__(self, model, class_list, device, transform, backbone):
        import torch  # local import — only fires if a custom classifier is loaded
        self._torch = torch
        self.model = model
        self.class_list = class_list
        self.device = device
        self.transform = transform
        self.backbone = backbone

    def single_image_classification(self, cropped_array):
        """Classify a single cropped numpy array. Matches the PW protocol."""
        torch = self._torch
        with torch.no_grad():
            tensor = self.transform(cropped_array).unsqueeze(0).to(self.device)
            logits = self.model(tensor)
            probs = torch.softmax(logits, dim=1)[0]
            top_conf, top_idx = torch.max(probs, dim=0)
            return {
                "prediction": self.class_list[int(top_idx.item())],
                "confidence": float(top_conf.item()),
            }


class TimmClassifier(_CropClassifier):
    """timm (contract v2) classifier loaded from local weights.

    backbone is a timm model name (e.g. tf_efficientnetv2_m.in21k_ft_in1k), fed
    to timm.create_model. Tolerates either a bare state_dict or a legacy nested
    checkpoint. Env vars are set by buildClassifierEnv() in ml-runner-env.ts.
    """

    @classmethod
    def from_env(cls, device):
        import json as _json
        import torch
        import timm

        weights_path, class_mapping_path, backbone, transform_json = _custom_classifier_env()
        class_list = _load_class_list(class_mapping_path)
        transform = _build_eval_transform(_json.loads(transform_json))

        # Build with the right class count BEFORE loading so the load is strict.
        model = timm.create_model(backbone, pretrained=False, num_classes=len(class_list))
        state = torch.load(weights_path, map_location="cpu")
        # Tolerate either a bare state_dict or a checkpoint dict {state_dict: ...}
        if isinstance(state, dict) and "state_dict" in state and not any(
            k.startswith("conv") or k.startswith("blocks") or "." in k for k in state.keys()
        ):
            state = state["state_dict"]
        model.load_state_dict(state, strict=True)
        model.eval().to(device)

        return cls(
            model=model,
            class_list=class_list,
            device=device,
            transform=transform,
            backbone=backbone,
        )


class OpenClipClassifier(_CropClassifier):
    """BioCLIP / open_clip (contract v3) classifier loaded from local weights.

    backbone is an open_clip spec (e.g. ``hf-hub:imageomics/bioclip-2.5-vith14``).
    Reconstruction MIRRORS the classifier repo's models.OpenClipClassifier: the
    open_clip visual trunk + a linear head, with submodule names ``trunk``/``head``
    that are load-bearing because weights.pt keys are ``trunk.*``/``head.*`` and
    the load is strict. The weights are a BARE state_dict — we deliberately do
    NOT apply timm's checkpoint-unwrap heuristic (every v3 key contains '.').

    Building the arch downloads the hub checkpoint into the HF cache (its weights
    are discarded by the strict load); the producer-emitted weights.pt provides
    the real parameters. Requires open_clip_torch + HF reachability (or a
    pre-warmed cache) at first reconstruction.
    """

    @classmethod
    def from_env(cls, device):
        import json as _json
        import torch
        import torch.nn as nn
        import open_clip

        weights_path, class_mapping_path, backbone, transform_json = _custom_classifier_env()
        class_list = _load_class_list(class_mapping_path)
        transform = _build_eval_transform(_json.loads(transform_json))

        _check_free_disk(min_gb=6)

        # Mirror the producer's models._build_open_clip prefix handling exactly:
        #   hf-hub:<repo>   -> create_model_and_transforms(<full string>)  (loads hub)
        #   open_clip:<arch> -> create_model_and_transforms(<arch>, pretrained=None)
        # open_clip itself only understands hf-hub:; "open_clip:" is the contract's
        # own convention for a plain (offline) arch. Production uses hf-hub:.
        if backbone.startswith("open_clip:"):
            arch = backbone[len("open_clip:"):]
            oc_model, _, _ = open_clip.create_model_and_transforms(arch, pretrained=None)
        else:
            oc_model, _, _ = open_clip.create_model_and_transforms(backbone)
        trunk = oc_model.visual
        embed_dim = int(getattr(trunk, "output_dim", None) or trunk.proj.shape[-1])

        class _OpenClipModule(nn.Module):
            # Mirror of classifier-repo models.OpenClipClassifier (trunk + head).
            def __init__(self, trunk, embed_dim, num_classes):
                super().__init__()
                self.trunk = trunk
                self.head = nn.Linear(embed_dim, num_classes)

            def forward(self, x):
                feats = self.trunk(x)
                if isinstance(feats, (tuple, list)):
                    feats = feats[0]  # pooled embedding is always first
                return self.head(feats)

        model = _OpenClipModule(trunk, embed_dim, len(class_list))
        # Bare state_dict, strict — no unwrap heuristic (v3 is always bare).
        state = torch.load(weights_path, map_location="cpu")
        model.load_state_dict(state, strict=True)
        model.eval().to(device)

        return cls(
            model=model,
            class_list=class_list,
            device=device,
            transform=transform,
            backbone=backbone,
        )


def load_image_safe(image_path):
    """Load a single image from disk. Returns dict with loaded data or error."""
    from PIL import Image
    import numpy as np

    try:
        pil_img = Image.open(image_path).convert("RGB")
        # EXIF note: converting to a numpy pixel array here drops all image
        # metadata (incl. poaching-relevant GPS). Classifier crops are taken
        # from this ndarray, so inference is already EXIF-free at this boundary
        # — no explicit strip is needed (matches the producer's _strip_exif).
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


def detections_from_result(det_result, item, classifier, confidence_threshold):
    """
    Convert one PytorchWildlife detector result dict into our output schema.
    Used by both the batched-inference path (det_result from batch_image_detection)
    and the per-image fallback (det_result from single_image_detection).

    The output format MUST stay byte-identical to the previous per-image path:
    bbox normalization uses item["width"]/item["height"] (PIL-reported dims), and
    floats are rounded to 4 decimal places. We deliberately ignore the library's
    `normalized_coords` field for the same byte-identicality reason.
    """
    detections_list = []

    if not det_result or "detections" not in det_result:
        return detections_list

    img_w = item["width"]
    img_h = item["height"]
    img_array = item["array"]
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

        # Classify animals (class_id 0). Classifier still runs per-detection
        # on cropped arrays — animals are a small fraction of detections and
        # the crop is cheap. Batching the classifier is not in scope for PR2.
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

    Note on "batching": we deliberately do NOT use detector.batch_image_detection
    here. A microbenchmark on Apple Silicon CPU + YOLOv9c showed that batched
    inference (one forward pass over 16 images) was ~20% SLOWER per image than
    sequential per-image calls. Batching speedups come from amortizing GPU kernel
    launch overhead — on CPU, inference is bound by memory bandwidth and one
    large tensor actually hurts cache behavior. See benchmark in
    docs/plans/2026-04-07-perf-camera-trap-ml-cpu-tuning-plan.md.

    The mini-batch loop here is just a chunking mechanism for pre-loading +
    cancel granularity, not a true model batch.

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

    job_start = time.monotonic()

    emit({"type": "info", "message": f"Job config: {total} images, batch_size={batch_size}, num_workers={num_workers}, {num_batches} batches"})

    for batch_start in range(0, total, batch_size):
        # Check for cancel between batches
        if check_cancel():
            cancelled = True
            break

        batch_paths = image_paths[batch_start:batch_start + batch_size]
        batch_num = batch_start // batch_size + 1
        batch_start_time = time.monotonic()

        # Pre-load images in parallel using thread pool
        if num_workers > 0:
            emit({"type": "info", "message": f"Batch {batch_num}/{num_batches}: preloading {len(batch_paths)} images with {num_workers} I/O workers"})
            with ThreadPoolExecutor(max_workers=num_workers) as pool:
                loaded_batch = list(pool.map(load_image_safe, batch_paths))
        else:
            emit({"type": "info", "message": f"Batch {batch_num}/{num_batches}: loading {len(batch_paths)} images sequentially"})
            loaded_batch = [load_image_safe(p) for p in batch_paths]

        load_elapsed = time.monotonic() - batch_start_time
        failed_in_batch = sum(1 for item in loaded_batch if item["error"])
        if failed_in_batch > 0:
            emit({"type": "info", "message": f"Batch {batch_num}: {failed_in_batch}/{len(batch_paths)} images failed to load"})

        # Process each pre-loaded image sequentially
        batch_detections = 0
        batch_species = {}
        for i, item in enumerate(loaded_batch):
            # Cancel check between individual images for responsiveness
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
                # Pass the already-loaded ndarray + img_path so PW uses our
                # pre-loaded array instead of re-opening the file from disk.
                # This is the PR1 preload fix — keep it. Verified API:
                # PytorchWildlife YOLOV8Base.single_image_detection(img, img_path=...)
                det_result = detector.single_image_detection(
                    item["array"], img_path=image_path
                )

                detections_list = detections_from_result(
                    det_result, item, classifier, confidence_threshold
                )

                emit({
                    "type": "result",
                    "image": image_path,
                    "detections": detections_list,
                })
                total_detections += len(detections_list)
                batch_detections += len(detections_list)
                processed += 1

                # Track species found in this batch
                for det in detections_list:
                    clf = det.get("classification")
                    if clf and clf.get("species"):
                        sp = clf["species"]
                        batch_species[sp] = batch_species.get(sp, 0) + 1

            except Exception as e:
                emit({
                    "type": "error",
                    "image": image_path,
                    "message": str(e),
                })
                processed += 1

        if cancelled:
            break

        # Batch summary
        batch_elapsed = time.monotonic() - batch_start_time
        infer_elapsed = batch_elapsed - load_elapsed
        imgs_per_sec = len(batch_paths) / batch_elapsed if batch_elapsed > 0 else 0
        species_str = ", ".join(f"{sp}={n}" for sp, n in sorted(batch_species.items())) if batch_species else "none"
        job_elapsed = time.monotonic() - job_start
        emit({
            "type": "info",
            "message": (
                f"Batch {batch_num}/{num_batches} done: "
                f"{len(batch_paths)} imgs in {batch_elapsed:.1f}s "
                f"(load {load_elapsed:.1f}s, infer {infer_elapsed:.1f}s, "
                f"{imgs_per_sec:.1f} img/s) — "
                f"{batch_detections} detections [{species_str}] — "
                f"cumulative: {processed}/{total} ({total_detections} det, {job_elapsed:.0f}s elapsed)"
            ),
        })

    job_elapsed = time.monotonic() - job_start
    overall_rate = processed / job_elapsed if job_elapsed > 0 else 0

    emit({
        "type": "info",
        "message": (
            f"Job complete: {processed}/{total} images in {job_elapsed:.1f}s "
            f"({overall_rate:.1f} img/s), {total_detections} total detections"
            + (", CANCELLED" if cancelled else "")
        ),
    })

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
