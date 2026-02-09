"use client";

import { useState, useEffect } from "react";

let cachedData: GeoJSON.FeatureCollection | null = null;

export function useReserveBoundary() {
  const [data, setData] = useState<GeoJSON.FeatureCollection | null>(cachedData);

  useEffect(() => {
    if (cachedData) return;
    fetch("/geojson/fcat-reserve.geojson")
      .then((res) => {
        if (!res.ok) return null;
        return res.json();
      })
      .then((json) => {
        if (json) {
          cachedData = json;
          setData(json);
        }
      })
      .catch(() => {
        // Silently fail if file doesn't exist
      });
  }, []);

  return data;
}
