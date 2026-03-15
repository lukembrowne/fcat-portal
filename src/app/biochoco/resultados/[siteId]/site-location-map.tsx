"use client";

import dynamic from "next/dynamic";

const MapInner = dynamic(() => import("./site-location-map-inner"), {
  ssr: false,
  loading: () => (
    <div className="h-[200px] bg-muted rounded-xl animate-pulse" />
  ),
});

interface SiteLocationMapProps {
  lat: number;
  lng: number;
}

export function SiteLocationMap({ lat, lng }: SiteLocationMapProps) {
  return <MapInner lat={lat} lng={lng} />;
}
