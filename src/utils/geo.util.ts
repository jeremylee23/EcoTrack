/**
 * utils/geo.util.ts
 * Geographic utility functions:
 *  - Haversine distance calculation
 *  - Coordinate validation (Taiwan bounds + 0,0 guard)
 *  - Teleport detection (sudden GPS jump)
 */

const EARTH_RADIUS_KM = 6371;

/**
 * Converts degrees to radians.
 */
function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * Calculates the great-circle distance between two GPS points (Haversine formula).
 * @returns Distance in kilometers.
 */
export function haversineDistance(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

/**
 * Taiwan bounding box (generous margin to include outlying islands).
 * Lat: 21.8 ~ 25.4 | Lng: 119.2 ~ 122.1
 */
const TAIWAN_BOUNDS = {
  latMin: 21.8,
  latMax: 25.4,
  lngMin: 119.2,
  lngMax: 122.1,
} as const;

/**
 * Validates that a GPS coordinate:
 *  1. Is not the degenerate (0, 0) point
 *  2. Falls within the Taiwan bounding box
 *  3. Contains finite, numeric values
 */
export function isValidCoordinate(lat: number, lng: number): boolean {
  if (!isFinite(lat) || !isFinite(lng)) return false;
  if (lat === 0 && lng === 0) return false;

  return (
    lat >= TAIWAN_BOUNDS.latMin &&
    lat <= TAIWAN_BOUNDS.latMax &&
    lng >= TAIWAN_BOUNDS.lngMin &&
    lng <= TAIWAN_BOUNDS.lngMax
  );
}

/**
 * Detects implausible GPS jumps ("teleportation") between two consecutive readings.
 * Uses elapsed time between readings to compute max plausible travel distance.
 *
 * @param prevLat  Previous latitude
 * @param prevLng  Previous longitude
 * @param currLat  Current latitude
 * @param currLng  Current longitude
 * @param prevTime Previous timestamp (ISO string)
 * @param currTime Current timestamp (ISO string)
 * @param maxSpeedKmh Maximum plausible vehicle speed (default: 80 km/h)
 * @returns true if the jump is implausible (teleport detected)
 */
export function isTeleport(
  prevLat: number,
  prevLng: number,
  currLat: number,
  currLng: number,
  prevTime: string,
  currTime: string,
  maxSpeedKmh = 80
): boolean {
  const distKm = haversineDistance(prevLat, prevLng, currLat, currLng);

  // Parse time delta in hours
  const prevMs = new Date(prevTime).getTime();
  const currMs = new Date(currTime).getTime();

  if (isNaN(prevMs) || isNaN(currMs)) return false; // can't determine, don't discard
  const deltaHours = Math.abs(currMs - prevMs) / (1000 * 60 * 60);

  // If update is too close in time (<1s), allow up to 500m jump
  if (deltaHours < 1 / 3600) {
    return distKm > 0.5;
  }

  const maxDistKm = maxSpeedKmh * deltaHours;
  return distKm > maxDistKm;
}

/**
 * Parses a HCCG time range string into a start time string.
 * e.g. "12:46~12:47" → "12:46"
 */
export function parseScheduledTime(timeRange: string): string | null {
  if (!timeRange || !timeRange.includes("~")) return null;
  return timeRange.split("~")[0].trim();
}

/**
 * Estimates ETA in minutes given:
 *  - straight-line distance from truck to target stop (km)
 *  - number of intermediate stops still to service
 *  - average speed and dwell time constants
 */
export function estimateEtaMinutes(
  distanceKm: number,
  intermediateStops: number,
  avgSpeedKmh: number,
  stopDwellSeconds: number
): number {
  const travelMinutes = (distanceKm / avgSpeedKmh) * 60;
  const dwellMinutes = (intermediateStops * stopDwellSeconds) / 60;
  return Math.round(travelMinutes + dwellMinutes);
}
