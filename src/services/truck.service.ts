/**
 * services/truck.service.ts
 * Handles:
 *  - Live truck GPS data in/out of Upstash Redis
 *  - ETA calculation combining Redis + PostGIS data
 *  - HCCG API fetching and data normalization
 */

import { Redis } from "@upstash/redis";
import { config } from "../config/index.js";
import { getSupabaseClient } from "./user.service.js";
import {
  haversineDistance,
  isValidCoordinate,
  isTeleport,
  estimateEtaMinutes,
  parseScheduledTime,
} from "../utils/geo.util.js";
import type {
  TruckLiveData,
  EtaResult,
  HccgApiResponse,
  HccgCarLocationData,
  HccgCleanPoint,
  HccgCleanPointData,
} from "../types/index.js";
import { getNextScheduledArrival } from "../utils/time.util.js";

// ── Redis client (singleton) ─────────────────────────────────

let _redis: Redis | null = null;

function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis({
      url: config.redis.restUrl,
      token: config.redis.restToken,
    });
  }
  return _redis;
}

// ── Redis key helpers ────────────────────────────────────────

const TRUCK_KEY = (routeId: string) => `truck_live:${routeId}`;
const USER_ROUTE_KEY = (userId: string) => `user_route:${userId}`;
// Round coordinates to ~11m so repeated queries from the same spot share a cache entry.
const POINTS_CACHE_KEY = (lat: number, lng: number) =>
  `points_cache:${lat.toFixed(4)}:${lng.toFixed(4)}`;

// Stale threshold: Redis data older than 6 hours is considered "today unavailable"
// (Truck ran yesterday, GPS off now — don't mislead user into thinking it's idle)
const STALE_THRESHOLD_MS = 6 * 60 * 60 * 1000;

// Official point query radii. Start narrow and widen to match the government UX.
const POINT_SEARCH_RADII_M = [120, 200, 300, 500] as const;
const DEFAULT_GARBAGE_DAYS = [1, 2, 4, 5, 6] as const;
const OFFICIAL_LIVE_STATUS = "1";

interface NearbyPointCandidate {
  point: HccgCleanPoint;
  distanceMeters: number;
  scheduledTime: string | null;
  minutesUntilScheduled: number | null;
  garbageEtaMinutes?: number;
  recyclingEtaMinutes?: number;
  hasTodayGarbage: boolean;
  hasTodayRecycling: boolean;
}

function getTaiwanNow(): Date {
  return new Date(Date.now() + 8 * 60 * 60 * 1000);
}

function getTaiwanWeekday(): number {
  const weekday = getTaiwanNow().getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

function getTaiwanMinutesOfDay(): number {
  const now = getTaiwanNow();
  return now.getUTCHours() * 60 + now.getUTCMinutes();
}

function hasServiceToday(daysString: string | null | undefined): boolean {
  if (!daysString) return false;

  const weekday = getTaiwanWeekday();
  return daysString
    .split(",")
    .map((value) => parseInt(value, 10))
    .some((value) => value === weekday);
}

function getMinutesUntilScheduled(scheduledTime: string | null): number | null {
  if (!scheduledTime) return null;

  const [hours, minutes] = scheduledTime.split(":").map(Number);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;

  return hours * 60 + minutes - getTaiwanMinutesOfDay();
}

function getOfficialEtaMinutes(
  point: HccgCleanPoint,
  carType: "0" | "1"
): number | undefined {
  const isToday = carType === "0"
    ? hasServiceToday(point.trashDay)
    : hasServiceToday(point.recycleDay);

  if (!isToday || point.status !== OFFICIAL_LIVE_STATUS) return undefined;

  const estimateSeconds = parseInt(point.estimate, 10);
  if (Number.isNaN(estimateSeconds) || estimateSeconds < 0) return undefined;

  return Math.max(1, Math.ceil(estimateSeconds / 60));
}

function buildPointCandidate(
  userLat: number,
  userLng: number,
  point: HccgCleanPoint
): NearbyPointCandidate {
  const lat = parseFloat(point.lat);
  const lng = parseFloat(point.lon);
  const scheduledTime = parseScheduledTime(point.time);

  return {
    point,
    distanceMeters: haversineDistance(userLat, userLng, lat, lng) * 1000,
    scheduledTime,
    minutesUntilScheduled: getMinutesUntilScheduled(scheduledTime),
    garbageEtaMinutes: getOfficialEtaMinutes(point, "0"),
    recyclingEtaMinutes: getOfficialEtaMinutes(point, "1"),
    hasTodayGarbage: hasServiceToday(point.trashDay),
    hasTodayRecycling: hasServiceToday(point.recycleDay),
  };
}

function getCandidateTimePenalty(candidate: NearbyPointCandidate): number {
  const diff = candidate.minutesUntilScheduled;
  if (diff === null) return 3000;
  if (diff < -90) return 6000 + Math.abs(diff);
  if (diff < -30) return 2000 + Math.abs(diff);
  if (diff > 240) return 1000 + diff;
  return Math.abs(diff);
}

function comparePointCandidates(
  left: NearbyPointCandidate,
  right: NearbyPointCandidate
): number {
  const leftHasEta =
    left.garbageEtaMinutes !== undefined ||
    left.recyclingEtaMinutes !== undefined;
  const rightHasEta =
    right.garbageEtaMinutes !== undefined ||
    right.recyclingEtaMinutes !== undefined;

  if (leftHasEta !== rightHasEta) return leftHasEta ? -1 : 1;

  const leftHasTodayService = left.hasTodayGarbage || left.hasTodayRecycling;
  const rightHasTodayService = right.hasTodayGarbage || right.hasTodayRecycling;
  if (leftHasTodayService !== rightHasTodayService) {
    return leftHasTodayService ? -1 : 1;
  }

  const timePenaltyDelta =
    getCandidateTimePenalty(left) - getCandidateTimePenalty(right);
  if (timePenaltyDelta !== 0) return timePenaltyDelta;

  return left.distanceMeters - right.distanceMeters;
}

async function fetchNearbyPointsFromHccg(
  userLat: number,
  userLng: number
): Promise<HccgCleanPoint[]> {
  let lastError: Error | null = null;

  for (const radius of POINT_SEARCH_RADII_M) {
    try {
      const params = new URLSearchParams({
        lat: userLat.toString(),
        lon: userLng.toString(),
        range: radius.toString(),
        locatemode: "1",
      });

      const response = await fetch(
        `${config.hccg.baseUrl}/getPointData?${params.toString()}`,
        {
          headers: {
            Referer: config.hccg.referer,
            "User-Agent": "EcoTrack-Bot/1.0",
          },
          signal: AbortSignal.timeout(5_000),
        }
      );

      if (!response.ok) {
        lastError = new Error(
          `[TruckService] HCCG point query returned ${response.status}`
        );
        break;
      }

      const json = (await response.json()) as HccgApiResponse<HccgCleanPointData>;
      if (json.statusCode !== 1 || !json.data) {
        lastError = new Error(
          `[TruckService] HCCG point query error: ${json.message}`
        );
        break;
      }

      const points = json.data.cleanPoint.filter((point) =>
        isValidCoordinate(parseFloat(point.lat), parseFloat(point.lon))
      );

      if (points.length > 0) return points;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      break;
    }
  }

  if (lastError) throw lastError;
  return [];
}

/**
 * Cached wrapper around fetchNearbyPointsFromHccg.
 * Caches non-empty results in Redis for a short window to reduce official API
 * load and stabilize responses. Empty results are never cached so they retry.
 */
async function fetchNearbyPointsCached(
  userLat: number,
  userLng: number
): Promise<HccgCleanPoint[]> {
  const redis = getRedis();
  const cacheKey = POINTS_CACHE_KEY(userLat, userLng);

  try {
    const cached = await redis.get<HccgCleanPoint[]>(cacheKey);
    if (cached && cached.length > 0) return cached;
  } catch (error) {
    console.error("[TruckService] Nearby points cache read failed:", error);
  }

  const points = await fetchNearbyPointsFromHccg(userLat, userLng);

  if (points.length > 0) {
    redis
      .set(cacheKey, points, { ex: config.hsinchu.nearbyCacheTtlSeconds })
      .catch((error) =>
        console.error("[TruckService] Nearby points cache write failed:", error)
      );
  }

  return points;
}

/**
 * Resolves the single best nearby clean point for a coordinate using the same
 * ranking as the ETA flow (official ETA → today's service → schedule → distance).
 * Shared by calculateEta and route-switch detection so both agree on the route.
 */
async function selectNearbyCandidate(
  userLat: number,
  userLng: number
): Promise<NearbyPointCandidate | null> {
  let nearbyPoints: HccgCleanPoint[] = [];

  try {
    nearbyPoints = await fetchNearbyPointsCached(userLat, userLng);
  } catch (error) {
    console.error("[TruckService] Failed to fetch nearby points:", error);
  }

  if (nearbyPoints.length === 0) return null;

  return (
    nearbyPoints
      .map((point) => buildPointCandidate(userLat, userLng, point))
      .sort(comparePointCandidates)[0] ?? null
  );
}

/**
 * Resolves the route a user's location currently maps to, via the official
 * nearby-point API. Used for route-switch detection when a user moves.
 */
export async function resolveNearestRoute(
  userLat: number,
  userLng: number
): Promise<{ routeId: string; routeName: string } | null> {
  const candidate = await selectNearbyCandidate(userLat, userLng);
  if (!candidate) return null;

  return {
    routeId: candidate.point.routeId,
    routeName: candidate.point.routeName,
  };
}

async function getRecentTruckFallback(
  routeId: string,
  carType: "0" | "1"
): Promise<TruckLiveData | null> {
  const fallback = carType === "0"
    ? (await getTruckLiveData(`${routeId}:0`)) ??
      (await getTruckLiveData(routeId))
    : await getTruckLiveData(`${routeId}:1`);

  if (!fallback) return null;

  const ageMs = Date.now() - new Date(fallback.updated_at).getTime();
  return ageMs < STALE_THRESHOLD_MS ? fallback : null;
}

function estimateEtaFromTruck(
  truck: TruckLiveData,
  stopLat: number,
  stopLng: number,
  targetSequence: number
): number {
  const intermediateStops = Math.max(
    0,
    targetSequence - truck.heading_to_stop_sequence - 1
  );
  const distanceKm = haversineDistance(truck.lat, truck.lng, stopLat, stopLng);

  return estimateEtaMinutes(
    distanceKm,
    intermediateStops,
    config.hsinchu.avgSpeedKmh,
    config.hsinchu.stopDwellSeconds
  );
}

// ── Redis CRUD ───────────────────────────────────────────────

/**
 * Reads the latest live GPS data for a given route from Redis.
 * Returns null if the key doesn't exist or has expired (>5 min TTL).
 */
export async function getTruckLiveData(
  routeId: string
): Promise<TruckLiveData | null> {
  const redis = getRedis();
  const data = await redis.get<TruckLiveData>(TRUCK_KEY(routeId));
  return data ?? null;
}

/**
 * Writes (overwrites) live GPS data to Redis for a given route.
 * Sets TTL to 300 seconds — data older than 5 min is considered stale.
 */
export async function setTruckLiveData(
  routeId: string,
  data: TruckLiveData
): Promise<void> {
  const redis = getRedis();
  await redis.set(TRUCK_KEY(routeId), data, {
    ex: config.hsinchu.truckLiveTtlSeconds,
  });
}

/**
 * Stores which route a user was last tracking.
 * Used to detect address changes and notify user of route switch.
 */
export async function getUserRouteId(userId: string): Promise<string | null> {
  const redis = getRedis();
  return redis.get<string>(USER_ROUTE_KEY(userId));
}

export async function setUserRouteId(userId: string, routeId: string, routeName: string): Promise<void> {
  const redis = getRedis();
  // Store as JSON so we can also retrieve the route name
  await redis.set(USER_ROUTE_KEY(userId), JSON.stringify({ routeId, routeName }), { ex: 60 * 60 * 24 * 7 }); // 7 days TTL
}

// ── ETA Calculation ──────────────────────────────────────────

/**
 * Calculates ETA for the truck nearest to the user's home location.
 *
 * Algorithm (Phase 1 MVP):
 * 1. Find the nearest route_stop to the user via PostGIS
 * 2. Fetch that route's truck from Redis
 * 3. Compute: distance(truck, stop) / avgSpeed + remainingStops * dwellTime
 */
export async function calculateEta(
  userLat: number,
  userLng: number
): Promise<EtaResult> {
  const candidate = await selectNearbyCandidate(userLat, userLng);

  if (!candidate) {
    return {
      found: false,
      message:
        "⚠️ 找不到您附近的清運點，請確認 GPS 位置是否正確，或改在表定時間前後再查一次。",
    };
  }

  const point = candidate.point;
  const routeId = point.routeId;
  const stopLat = parseFloat(point.lat);
  const stopLng = parseFloat(point.lon);
  const targetSequence = parseInt(point.seq, 10) || 0;
  const formattedTime = candidate.scheduledTime ?? "未知";
  const stopName = point.pointName || point.address;

  const historicalAvg =
    targetSequence > 0
      ? await getHistoricalAverage(routeId, targetSequence)
      : undefined;
  const historicalReference = historicalAvg ?? (point.historyTime || undefined);

  let truckData = await syncSingleTruckFromHccg(routeId).catch((error) => {
    console.error("[TruckService] Failed to fetch single truck:", error);
    return { garbage: null, recycling: null };
  });

  if (!truckData.garbage) {
    truckData.garbage = await getRecentTruckFallback(routeId, "0");
  }
  if (!truckData.recycling) {
    truckData.recycling = await getRecentTruckFallback(routeId, "1");
  }

  const garbageTruck = truckData.garbage;
  const recyclingTruck = truckData.recycling;

  const garbageEtaMinutes =
    candidate.garbageEtaMinutes ??
    (garbageTruck
      ? estimateEtaFromTruck(garbageTruck, stopLat, stopLng, targetSequence)
      : undefined);

  const recyclingEtaMinutes =
    candidate.recyclingEtaMinutes ??
    (recyclingTruck
      ? estimateEtaFromTruck(recyclingTruck, stopLat, stopLng, targetSequence)
      : undefined);

  const isGarbagePassed =
    candidate.garbageEtaMinutes === undefined &&
    (garbageTruck
      ? garbageTruck.heading_to_stop_sequence > targetSequence
      : candidate.minutesUntilScheduled !== null &&
        candidate.minutesUntilScheduled < -30);

  const isRecyclePassed =
    candidate.recyclingEtaMinutes === undefined &&
    (recyclingTruck
      ? recyclingTruck.heading_to_stop_sequence > targetSequence
      : candidate.minutesUntilScheduled !== null &&
        candidate.minutesUntilScheduled < -30);

  const nextGarbageInfo = getNextScheduledArrival(
    point.trashDay,
    candidate.scheduledTime,
    isGarbagePassed,
    [...DEFAULT_GARBAGE_DAYS]
  );
  const nextRecycleInfo = getNextScheduledArrival(
    point.recycleDay,
    candidate.scheduledTime,
    isRecyclePassed
  );

  if (
    garbageEtaMinutes === undefined &&
    recyclingEtaMinutes === undefined &&
    (!nextGarbageInfo || !nextGarbageInfo.isToday) &&
    (!nextRecycleInfo || !nextRecycleInfo.isToday)
  ) {
    const nextGarbageText = nextGarbageInfo
      ? `\n🚛 下次垃圾車：${nextGarbageInfo.dateStr}`
      : "";
    const nextRecycleText = nextRecycleInfo
      ? `\n♻️ 下次回收車：${nextRecycleInfo.dateStr}`
      : "";
    const historicalText = historicalReference
      ? `\n📊 歷史平均：約 ${historicalReference}`
      : "";

    return {
      found: true,
      routeId,
      routeName: point.routeName,
      nearestStopName: point.pointName || undefined,
      nearestStopAddress: point.address || undefined,
      stopLat,
      stopLng,
      userLat,
      userLng,
      scheduledTime: formattedTime,
      historicalAvgTime: historicalReference,
      nextGarbageDate: nextGarbageInfo?.dateStr,
      nextRecycleDate: nextRecycleInfo?.dateStr,
      isGarbagePassed,
      isRecyclePassed,
      message:
        `📍 最近清運點：${stopName}\n` +
        `🕐 官方表定：${formattedTime}${historicalText}` +
        `${nextGarbageText}${nextRecycleText}`,
    };
  }

  const now = new Date();
  const db = getSupabaseClient();

  if (garbageEtaMinutes !== undefined) {
    db.from("eta_logs")
      .insert({
        route_id: routeId,
        stop_id: targetSequence,
        car_no: (garbageTruck?.car_no ?? point.carNo) || null,
        user_lat: userLat,
        user_lng: userLng,
        estimated_eta_minutes: garbageEtaMinutes,
        predicted_arrival_time: new Date(
          now.getTime() + garbageEtaMinutes * 60000
        ).toISOString(),
        car_type: "0",
      })
      .then(({ error }) => {
        if (error) {
          console.error(
            "[TruckService] Failed to insert garbage eta_log:",
            error.message
          );
        }
      });
  }

  if (recyclingEtaMinutes !== undefined) {
    db.from("eta_logs")
      .insert({
        route_id: routeId,
        stop_id: targetSequence,
        car_no: (recyclingTruck?.car_no ?? point.rcarNo) || null,
        user_lat: userLat,
        user_lng: userLng,
        estimated_eta_minutes: recyclingEtaMinutes,
        predicted_arrival_time: new Date(
          now.getTime() + recyclingEtaMinutes * 60000
        ).toISOString(),
        car_type: "1",
      })
      .then(({ error }) => {
        if (error) {
          console.error(
            "[TruckService] Failed to insert recycling eta_log:",
            error.message
          );
        }
      });
  }

  const messageLines = [
    `📍 最近清運點：${stopName}`,
    `🕐 官方表定：${formattedTime}`,
    historicalReference ? `📊 歷史平均：約 ${historicalReference}` : null,
    garbageEtaMinutes !== undefined
      ? `🚛 垃圾車：約 ${garbageEtaMinutes} 分鐘`
      : nextGarbageInfo && !nextGarbageInfo.isToday
        ? `🚛 下次垃圾車：${nextGarbageInfo.dateStr}`
        : "⚠️ 垃圾車目前沒有可用的即時 ETA",
    recyclingEtaMinutes !== undefined
      ? `♻️ 回收車：約 ${recyclingEtaMinutes} 分鐘`
      : nextRecycleInfo && !nextRecycleInfo.isToday
        ? `♻️ 下次回收車：${nextRecycleInfo.dateStr}`
        : null,
  ].filter((line): line is string => Boolean(line));

  return {
    found: true,
    routeId,
    routeName: point.routeName,
    nearestStopName: point.pointName || undefined,
    nearestStopAddress: point.address || undefined,
    stopLat,
    stopLng,
    userLat,
    userLng,
    etaMinutes: garbageEtaMinutes,
    carNo: (garbageTruck?.car_no ?? point.carNo) || undefined,
    truckLat: garbageTruck?.lat,
    truckLng: garbageTruck?.lng,
    recyclingCarNo: (recyclingTruck?.car_no ?? point.rcarNo) || undefined,
    recyclingTruckLat: recyclingTruck?.lat,
    recyclingTruckLng: recyclingTruck?.lng,
    recyclingEtaMinutes,
    scheduledTime: formattedTime,
    historicalAvgTime: historicalReference,
    nextGarbageDate: nextGarbageInfo?.isToday ? undefined : nextGarbageInfo?.dateStr,
    nextRecycleDate: nextRecycleInfo?.isToday ? undefined : nextRecycleInfo?.dateStr,
    isGarbagePassed,
    isRecyclePassed,
    message: messageLines.join("\n"),
    isStale: false,
    staleMinutes: 0,
  } as EtaResult & { isStale?: boolean; staleMinutes?: number };
}

async function getHistoricalAverage(routeId: string, stopId: number): Promise<string | undefined> {
  try {
    const db = getSupabaseClient();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    
    const { data, error } = await db
      .from('eta_logs')
      .select('predicted_arrival_time')
      .eq('route_id', routeId)
      .eq('stop_id', stopId)
      .gte('created_at', thirtyDaysAgo);
      
    if (error || !data || data.length === 0) return undefined;
    
    let totalMinutes = 0;
    let count = 0;
    
    for (const log of data) {
      if (!log.predicted_arrival_time) continue;
      const date = new Date(log.predicted_arrival_time);
      const hours = (date.getUTCHours() + 8) % 24;
      const minutes = date.getUTCMinutes();
      totalMinutes += (hours * 60 + minutes);
      count++;
    }
    
    if (count === 0) return undefined;
    
    const avgTotalMinutes = Math.round(totalMinutes / count);
    const avgHours = Math.floor(avgTotalMinutes / 60);
    const avgMins = avgTotalMinutes % 60;
    
    return `${avgHours.toString().padStart(2, '0')}:${avgMins.toString().padStart(2, '0')}`;
  } catch (e) {
    console.error("[TruckService] Error calculating historical average:", e);
    return undefined;
  }
}

// ── HCCG API sync ────────────────────────────────────────────

/**
 * Fetches the latest GPS position for a SINGLE vehicle route from the HCCG API.
 * This is incredibly fast and avoids the heavy lifting of parsing all 130+ trucks.
 * Saves to Redis and resolves ETA logs asynchronously.
 */
export async function syncSingleTruckFromHccg(routeId: string): Promise<{ garbage: TruckLiveData | null, recycling: TruckLiveData | null }> {
  const result = { garbage: null as TruckLiveData | null, recycling: null as TruckLiveData | null };
  const url = `${config.hccg.baseUrl}/getCarLocation?rId=${routeId}`;

  const response = await fetch(url, {
    headers: {
      Referer: config.hccg.referer,
      "User-Agent": "EcoTrack-Bot/1.0",
    },
    signal: AbortSignal.timeout(5_000), // very short timeout for UX
  });

  if (!response.ok) return result;

  const json = (await response.json()) as HccgApiResponse<HccgCarLocationData>;
  if (json.statusCode !== 1 || !json.data || json.data.car.length === 0) return result;

  const db = getSupabaseClient();

  for (const car of json.data.car) {
    const lat = parseFloat(car.lat);
    const lng = parseFloat(car.lon);

    if (!isValidCoordinate(lat, lng)) continue;

    const liveData: TruckLiveData = {
      lat,
      lng,
      speed: 0,
      updated_at: new Date(
        car.updateTime.replace(/(\d{4})\/(\d{2})\/(\d{2}) /, "$1-$2-$3T")
      ).toISOString(),
      heading_to_stop_sequence: parseInt(car.seq, 10) || 0,
      car_no: car.carNo,
      route_name: car.routeName,
      status: car.carStatus,
      direction: car.direction,
      car_type: car.carType,
    };

    if (car.carType === "0") {
      result.garbage = liveData;
    } else if (car.carType === "1") {
      result.recycling = liveData;
    }

    // Async save to Redis (key separated by car_type)
    setTruckLiveData(`${car.routeId}:${car.carType}`, liveData).catch(console.error);

    // Async resolve ETA logs
    const currentSeq = parseInt(car.seq, 10);
    if (!isNaN(currentSeq) && currentSeq > 0) {
      db.from("eta_logs")
        .update({ actual_arrival_time: liveData.updated_at })
        .eq("route_id", car.routeId)
        .eq("car_type", car.carType)
        .is("actual_arrival_time", null)
        .lte("stop_id", currentSeq)
        .then(({error}) => {
          if (error) console.error("[TruckService] Failed to resolve eta_logs:", error.message);
        });
    }
  }

  return result;
}

/**
 * Fetches the latest GPS positions for all vehicles from the HCCG API.
 * Filters to Xiangshan district routes, applies validation, writes to Redis.
 *
 * Called by the /api/cron/sync-trucks endpoint.
 */
export async function syncTrucksFromHccg(): Promise<{
  processed: number;
  skipped: number;
  errors: string[];
}> {
  const url = `${config.hccg.baseUrl}/getCarLocation?rId=all`;

  const response = await fetch(url, {
    headers: {
      Referer: config.hccg.referer,
      "User-Agent": "EcoTrack-Bot/1.0",
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`[TruckService] HCCG API returned ${response.status}`);
  }

  const json = (await response.json()) as HccgApiResponse<HccgCarLocationData>;

  if (json.statusCode !== 1 || !json.data) {
    throw new Error(`[TruckService] HCCG API error: ${json.message}`);
  }

  const { car: cars } = json.data;

  // Previous live data cache for teleport detection
  const previousCache = new Map<string, TruckLiveData>();

  // Pre-load existing Redis data for teleport check
  const carKeys = cars.map((c) => `${c.routeId}:${c.carType}`);
  await Promise.all(
    carKeys.map(async (key) => {
      const existing = await getTruckLiveData(key);
      if (existing) previousCache.set(key, existing);
    })
  );

  let processed = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const car of cars) {
    try {
      const lat = parseFloat(car.lat);
      const lng = parseFloat(car.lon);

      // Guard 1: valid coordinate
      if (!isValidCoordinate(lat, lng)) {
        skipped++;
        continue;
      }

      // Guard 2: teleport detection
      const cacheKey = `${car.routeId}:${car.carType}`;
      const prev = previousCache.get(cacheKey);
      if (prev) {
        const prevTime = prev.updated_at;
        // Parse HCCG time format: "YYYY/MM/DD HH:mm:ss"
        const currTime = car.updateTime.replace(
          /(\d{4})\/(\d{2})\/(\d{2}) /,
          "$1-$2-$3T"
        );
        if (isTeleport(prev.lat, prev.lng, lat, lng, prevTime, currTime)) {
          skipped++;
          errors.push(
            `[Skip] Teleport detected for route ${car.routeId} car ${car.carNo}`
          );
          continue;
        }
      }

      const liveData: TruckLiveData = {
        lat,
        lng,
        speed: 0, // HCCG API doesn't provide speed directly
        updated_at: new Date(
          car.updateTime.replace(/(\d{4})\/(\d{2})\/(\d{2}) /, "$1-$2-$3T")
        ).toISOString(),
        heading_to_stop_sequence: parseInt(car.seq, 10) || 0,
        car_no: car.carNo,
        route_name: car.routeName,
        status: car.carStatus,
        direction: car.direction,
        car_type: car.carType,
      };

      await setTruckLiveData(cacheKey, liveData);
      
      // Resolve pending ETA logs
      // If the truck's current sequence is > logged stop sequence, it means it has passed the stop.
      // (Assuming seq increases. In reality, we might check if seq >= logged seq)
      const currentSeq = parseInt(car.seq, 10);
      if (!isNaN(currentSeq) && currentSeq > 0) {
        const db = getSupabaseClient();
        const updateTime = new Date(
          car.updateTime.replace(/(\d{4})\/(\d{2})\/(\d{2}) /, "$1-$2-$3T")
        ).toISOString();
        
        // This is a simplified check. We mark logs as arrived if the truck is at or past the stop.
        // We do it non-blocking.
        db.from("eta_logs")
          .update({ actual_arrival_time: updateTime })
          .eq("route_id", car.routeId)
          .eq("car_type", car.carType)
          .is("actual_arrival_time", null)
          .lte("stop_id", currentSeq)
          .then(({error}) => {
            if (error) console.error("[TruckService] Failed to resolve eta_logs:", error.message);
          });
      }

      processed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`[Error] route ${car.routeId}: ${msg}`);
    }
  }

  return { processed, skipped, errors };
}

/**
 * Fetches all district stop points from HCCG API.
 * Used for seeding/updating the route_stops table.
 */
export async function fetchAllStops(): Promise<HccgCleanPointData | null> {
  const url = `${config.hccg.baseUrl}/getPointData?address=`;

  const response = await fetch(url, {
    headers: {
      Referer: config.hccg.referer,
      "User-Agent": "EcoTrack-Bot/1.0",
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) return null;

  const json = (await response.json()) as HccgApiResponse<HccgCleanPointData>;
  if (json.statusCode !== 1 || !json.data) return null;

  return {
    total: json.data.cleanPoint.length,
    cleanPoint: json.data.cleanPoint,
  };
}
