/**
 * Detect when「定位」and a favorite refer to the same real-world place
 * so queries share one canonical GPS (avoid different clean-point suggestions).
 */

import { haversineDistance } from "./geo.util.js";

/** Same place if GPS within this many meters. */
export const SAME_PLACE_RADIUS_M = 40;

export function normalizeAddressKey(
  raw: string | null | undefined
): string | null {
  if (!raw?.trim()) return null;
  let s = raw.trim().replace(/\s+/g, "");
  s = s.replace(/^台灣/, "").replace(/^臺灣/, "");
  s = s.replace(/^新竹市/, "").replace(/^新竹縣/, "");
  s = s.replace(/附近$/, "");
  // Drop optional floor/room noise
  s = s.replace(/[0-9]+樓.*$/, "");
  return s || null;
}

export function addressesLikelySame(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  const na = normalizeAddressKey(a);
  const nb = normalizeAddressKey(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // One is a prefix/suffix of the other (short label vs full LINE address)
  if (na.includes(nb) || nb.includes(na)) return true;
  return false;
}

export function coordsWithinMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
  meters: number = SAME_PLACE_RADIUS_M
): boolean {
  return haversineDistance(lat1, lng1, lat2, lng2) * 1000 <= meters;
}

export function isSamePlace(options: {
  homeLat: number;
  homeLng: number;
  homeAddress?: string | null;
  spotLat: number;
  spotLng: number;
  spotAddress?: string | null;
}): boolean {
  if (
    coordsWithinMeters(
      options.homeLat,
      options.homeLng,
      options.spotLat,
      options.spotLng
    )
  ) {
    return true;
  }
  return addressesLikelySame(options.homeAddress, options.spotAddress);
}
