/**
 * WGS84 → UTM Zone 17N conversion.
 * All FCAT sites are in zone 17N (central meridian −81°).
 */

export interface UtmCoordinate {
  easting: number;
  northing: number;
  zone: 17;
  hemisphere: "N";
}

// WGS84 ellipsoid constants
const a = 6378137; // semi-major axis (m)
const f = 1 / 298.257223563; // flattening
const e2 = 2 * f - f * f; // eccentricity squared
const e_prime2 = e2 / (1 - e2); // second eccentricity squared
const k0 = 0.9996; // UTM scale factor
const CM = -81; // central meridian for zone 17 (degrees)

/**
 * Convert WGS84 lat/lng to UTM Zone 17N coordinates.
 */
export function toUtm17N(lat: number, lng: number): UtmCoordinate {
  const latRad = (lat * Math.PI) / 180;
  const lngRad = (lng * Math.PI) / 180;
  const cmRad = (CM * Math.PI) / 180;

  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  const tanLat = Math.tan(latRad);

  const N = a / Math.sqrt(1 - e2 * sinLat * sinLat);
  const T = tanLat * tanLat;
  const C = e_prime2 * cosLat * cosLat;
  const A = cosLat * (lngRad - cmRad);

  // Meridional arc length
  const e4 = e2 * e2;
  const e6 = e4 * e2;
  const M =
    a *
    ((1 - e2 / 4 - (3 * e4) / 64 - (5 * e6) / 256) * latRad -
      ((3 * e2) / 8 + (3 * e4) / 32 + (45 * e6) / 1024) *
        Math.sin(2 * latRad) +
      ((15 * e4) / 256 + (45 * e6) / 1024) * Math.sin(4 * latRad) -
      ((35 * e6) / 3072) * Math.sin(6 * latRad));

  const A2 = A * A;
  const A3 = A2 * A;
  const A4 = A3 * A;
  const A5 = A4 * A;
  const A6 = A5 * A;

  const easting =
    500000 +
    k0 *
      N *
      (A +
        ((1 - T + C) * A3) / 6 +
        ((5 - 18 * T + T * T + 72 * C - 58 * e_prime2) * A5) / 120);

  const northing =
    k0 *
    (M +
      N *
        tanLat *
        (A2 / 2 +
          ((5 - T + 9 * C + 4 * C * C) * A4) / 24 +
          ((61 - 58 * T + T * T + 600 * C - 330 * e_prime2) * A6) / 720));

  return { easting, northing, zone: 17, hemisphere: "N" };
}

/**
 * Format a UTM coordinate as a display string, e.g. "699,123 E  9,812,345 N"
 */
export function formatUtm(utm: UtmCoordinate): string {
  const e = Math.round(utm.easting).toLocaleString("en-US");
  const n = Math.round(utm.northing).toLocaleString("en-US");
  return `${e} E  ${n} N`;
}
