"use client";

import { useEffect, useRef, useState, useCallback } from "react";

const MAX_ZOOM = 8;
const ZOOM_SPEED = 0.003;
const PAN_BOUND_RATIO = 0.5; // Keep at least 50% of image visible

interface ZoomState {
  scale: number;
  translateX: number;
  translateY: number;
}

interface UseImageZoomOptions {
  disabled?: boolean;
}

export function useImageZoom(opts?: UseImageZoomOptions) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState<ZoomState>({ scale: 1, translateX: 0, translateY: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const panRef = useRef<{ startX: number; startY: number; startTx: number; startTy: number } | null>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  const disabled = opts?.disabled ?? false;

  const clampTranslate = useCallback(
    (tx: number, ty: number, scale: number): { tx: number; ty: number } => {
      const container = containerRef.current;
      if (!container || scale <= 1) return { tx: 0, ty: 0 };

      const rect = container.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;

      // Scaled content dimensions
      const contentW = w * scale;
      const contentH = h * scale;

      // Allow panning so at least PAN_BOUND_RATIO of the image is visible
      const minTx = -(contentW - w * PAN_BOUND_RATIO);
      const maxTx = w * (1 - PAN_BOUND_RATIO);
      const minTy = -(contentH - h * PAN_BOUND_RATIO);
      const maxTy = h * (1 - PAN_BOUND_RATIO);

      return {
        tx: Math.max(minTx, Math.min(maxTx, tx)),
        ty: Math.max(minTy, Math.min(maxTy, ty)),
      };
    },
    []
  );

  const resetZoom = useCallback(() => {
    setZoom({ scale: 1, translateX: 0, translateY: 0 });
  }, []);

  // Wheel zoom — must use addEventListener for { passive: false }
  useEffect(() => {
    const container = containerRef.current;
    if (!container || disabled) return;

    function handleWheel(e: WheelEvent) {
      e.preventDefault();

      const container = containerRef.current;
      if (!container) return;

      const z = zoomRef.current;
      const rect = container.getBoundingClientRect();

      // Cursor position relative to container
      const cursorX = e.clientX - rect.left;
      const cursorY = e.clientY - rect.top;

      // Normalize delta across deltaMode values
      let delta = e.deltaY;
      if (e.deltaMode === 1) delta *= 40; // DOM_DELTA_LINE
      if (e.deltaMode === 2) delta *= 800; // DOM_DELTA_PAGE

      const newScale = Math.max(1, Math.min(MAX_ZOOM, z.scale * (1 - delta * ZOOM_SPEED)));

      // Zoom toward cursor: keep the image point under the cursor fixed
      const newTx = cursorX - ((cursorX - z.translateX) / z.scale) * newScale;
      const newTy = cursorY - ((cursorY - z.translateY) / z.scale) * newScale;

      const clamped = clampTranslate(newTx, newTy, newScale);
      setZoom({ scale: newScale, translateX: clamped.tx, translateY: clamped.ty });
    }

    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => container.removeEventListener("wheel", handleWheel);
  }, [disabled, clampTranslate]);

  // Space key tracking for pan mode
  useEffect(() => {
    if (disabled) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === " " && !e.repeat) {
        // Don't intercept Space in editable fields
        const target = e.target as HTMLElement;
        if (
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target instanceof HTMLSelectElement ||
          target.isContentEditable
        ) {
          return;
        }
        e.preventDefault();
        setIsPanning(true);
      }
    }

    function handleKeyUp(e: KeyboardEvent) {
      if (e.key === " ") {
        setIsPanning(false);
        panRef.current = null;
      }
    }

    function handleBlur() {
      // Reset panning if window loses focus while Space is held
      setIsPanning(false);
      panRef.current = null;
    }

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
    };
  }, [disabled]);

  // Pan pointer handlers
  const handlePanPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!isPanning || zoom.scale <= 1) return;
      e.preventDefault();
      e.stopPropagation();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      panRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        startTx: zoom.translateX,
        startTy: zoom.translateY,
      };
    },
    [isPanning, zoom.scale, zoom.translateX, zoom.translateY]
  );

  const handlePanPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!panRef.current) return;
      const dx = e.clientX - panRef.current.startX;
      const dy = e.clientY - panRef.current.startY;
      const newTx = panRef.current.startTx + dx;
      const newTy = panRef.current.startTy + dy;
      const clamped = clampTranslate(newTx, newTy, zoom.scale);
      setZoom((prev) => ({ ...prev, translateX: clamped.tx, translateY: clamped.ty }));
    },
    [zoom.scale, clampTranslate]
  );

  const handlePanPointerUp = useCallback(() => {
    panRef.current = null;
  }, []);

  const style: React.CSSProperties = {
    transform: `translate(${zoom.translateX}px, ${zoom.translateY}px) scale(${zoom.scale})`,
    transformOrigin: "0 0",
    willChange: zoom.scale > 1 ? "transform" : undefined,
  };

  const panHandlers = isPanning && zoom.scale > 1
    ? {
        onPointerDown: handlePanPointerDown,
        onPointerMove: handlePanPointerMove,
        onPointerUp: handlePanPointerUp,
      }
    : {};

  return {
    containerRef,
    wrapperRef,
    style,
    panHandlers,
    scale: zoom.scale,
    isPanning,
    resetZoom,
  };
}
