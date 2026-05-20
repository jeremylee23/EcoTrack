/**
 * services/truck.service.ts
 * Handles:
 *  - Live truck GPS data in/out of Upstash Redis
 *  - ETA calculation combining Redis + PostGIS data
 *  - HCCG API fetching and data normalization
 */

import { Redis } from "@upstash/redis";
import { config } from "../config/index.js";
import { getNearestStop, getSupabaseClient } from "./user.service.js";
import {
  haversineDistance,
  isValidCoordinate,
  isTeleport,
  estimateEtaMinutes,
} from "../utils/geo.util.js";
import type {
  TruckLiveData,
  EtaResult,
  HccgApiResponse,
  HccgCarLocationData,
  HccgCarLocation,
  HccgCleanPointData,
} from "../types/index.js";

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

// Stale threshold: Redis data older than 6 hours is considered "today unavailable"
// (Truck ran yesterday, GPS off now — don't mislead user into thinking it's idle)
const STALE_THRESHOLD_MS = 6 * 60 * 60 * 1000;

// Alternative route search radius when primary route has no active truck
const ALT_ROUTE_RADIUS_M = 100;

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
  // Step 1: nearest stops from PostGIS (returns up to 20)
  const nearestStops = await getNearestStop(userLat, userLng);

  if (!nearestStops || nearestStops.length === 0) {
    return {
      found: false,
      message:
        "⚠️ 找不到您附近 1.5 公里內的清運站點，請確認您已傳送正確的位置，或目前此區域今日無清運服務。",
    };
  }

  // Step 2: Fast fetch of all active trucks (just in-memory, no Redis saves!) to avoid 15s latency
  let activeRouteIds = new Set<string>();
  try {
    const url = `${config.hccg.baseUrl}/getCarLocation?rId=all`;
    const response = await fetch(url, { headers: { Referer: config.hccg.referer }, signal: AbortSignal.timeout(3000) });
    if (response.ok) {
       const json = (await response.json()) as HccgApiResponse<HccgCarLocationData>;
       if (json.statusCode === 1 && json.data) {
          json.data.car.forEach(c => activeRouteIds.add(`${c.routeId}:${c.carType}`));
       }
    }
  } catch (err) {
    console.error("[TruckService] Failed to fast-fetch active trucks:", err);
  }

  let nearestStop = nearestStops[0];
  let hasActiveTruck = false;

  const currentTime = new Date();
  const currentMinutes = ((currentTime.getUTCHours() + 8) % 24) * 60 + currentTime.getUTCMinutes();

  // Find if any nearby stop has an active truck in memory
  for (const stop of nearestStops) {
    const isGarbageActive = activeRouteIds.has(`${stop.route_id}:0`) || activeRouteIds.has(stop.route_id);
    const isRecyclingActive = activeRouteIds.has(`${stop.route_id}:1`);
    
    let isScheduleValid = true;
    if (stop.scheduled_time) {
      const [h, m] = stop.scheduled_time.split(':').map(Number);
      const diff = (h * 60 + m) - currentMinutes;
      if (diff < -90) isScheduleValid = false; // more than 1.5 hours in the past
    }
    
    if ((isGarbageActive || isRecyclingActive) && isScheduleValid) {
      nearestStop = stop;
      hasActiveTruck = true;
      break;
    }
  }

  // If no active trucks found, fallback to time-based selection
  if (!hasActiveTruck) {
    let bestUpcomingStop = nearestStops[0]; // fallback to geographically nearest
    let bestTimeDiff = Infinity;
    
    for (const stop of nearestStops) {
      if (!stop.scheduled_time) continue;
      const [h, m] = stop.scheduled_time.split(':').map(Number);
      const stopMinutes = h * 60 + m;
      
      const diff = stopMinutes - currentMinutes;
      // We allow up to 60 minutes in the past (diff >= -60), meaning truck might be delayed
      // Pick the closest upcoming valid stop
      if (diff >= -60 && diff < bestTimeDiff) {
        bestTimeDiff = diff;
        bestUpcomingStop = stop;
      }
    }
    nearestStop = bestUpcomingStop;
  }

  // Step 3: Now fetch real-time data ONLY for the single chosen route and save it to Redis
  let truckData = await syncSingleTruckFromHccg(nearestStop.route_id).catch(err => {
    console.error("[TruckService] Failed to fetch single truck:", err);
    return { garbage: null, recycling: null };
  });

  // Fallback to Redis ONLY if data is recent (< 6 hours).
  // Avoid misleading user: if Monday's Redis data is returned on Wednesday,
  // the truck looks "idle for 2 days" even though it ran on Tuesday.
  const now_fallback = Date.now();
  if (!truckData.garbage) {
    const redisFallback = await getTruckLiveData(`${nearestStop.route_id}:0`)
      ?? await getTruckLiveData(nearestStop.route_id);
    if (redisFallback) {
      const ageMs = now_fallback - new Date(redisFallback.updated_at).getTime();
      if (ageMs < STALE_THRESHOLD_MS) truckData.garbage = redisFallback;
    }
  }
  if (!truckData.recycling) {
    const recFallback = await getTruckLiveData(`${nearestStop.route_id}:1`);
    if (recFallback) {
      const ageMs = now_fallback - new Date(recFallback.updated_at).getTime();
      if (ageMs < STALE_THRESHOLD_MS) truckData.recycling = recFallback;
    }
  }

  // Fix 3: If primary route has no active truck, try alternative routes within 100m
  if (!truckData.garbage && !truckData.recycling) {
    for (const altStop of nearestStops.slice(1)) {
      if (altStop.route_id === nearestStop.route_id) continue;
      const altDistM = haversineDistance(userLat, userLng, altStop.lat, altStop.lng) * 1000;
      if (altDistM > ALT_ROUTE_RADIUS_M) continue;

      const altData = await syncSingleTruckFromHccg(altStop.route_id).catch(() => ({
        garbage: null, recycling: null,
      }));
      if (altData.garbage || altData.recycling) {
        console.log(`[TruckService] Switched to alt route ${altStop.route_id} (${altDistM.toFixed(0)}m away)`);
        nearestStop = altStop;
        truckData = altData;
        break;
      }
    }
  }

  const garbageTruck = truckData.garbage;
  const recyclingTruck = truckData.recycling;
  
  const historicalAvg = await getHistoricalAverage(nearestStop.route_id, nearestStop.sequence_order);
  const avgStr = historicalAvg ? `\n📊 歷史平均：約 ${historicalAvg}` : "";

  if (!garbageTruck && !recyclingTruck) {
    const timeStr = nearestStop.scheduled_time ? nearestStop.scheduled_time.slice(0, 5) : "未知";
    return {
      found: false,
      message: `⚠️ 今日目前無法取得此區域垃圾車的即時 GPS 訊號。\n\n` +
               `📍 最近清運點：${nearestStop.point_name ?? nearestStop.address}\n` +
               `🕐 官方表定時間：${timeStr}${avgStr}\n\n` +
               `💡 注意：即使顯示無訊號，昨日垃圾車仍可能正常出動。\n` +
               `此查詢結果為當下即時訊號，建議在表定時間前 30 分鐘再次查詢！`,
    };
  }

  if (!garbageTruck) {
    const timeStr = nearestStop.scheduled_time ? nearestStop.scheduled_time.slice(0, 5) : "未知";
    return {
      found: true,
      routeId: nearestStop.route_id,
      nearestStopName: nearestStop.point_name ?? undefined,
      nearestStopAddress: nearestStop.address ?? undefined,
      stopLat: nearestStop.lat,
      stopLng: nearestStop.lng,
      userLat,
      userLng,
      scheduledTime: timeStr,
      historicalAvgTime: historicalAvg,
      message: `📍 找到最近的清運點：${nearestStop.point_name ?? nearestStop.address}\n` +
               `🕐 官方表定 (僅供參考)：${timeStr}${avgStr}\n` +
               `⚠️ 目前無法取得垃圾車的即時 GPS 訊號（可能尚未出車或訊號中斷），請稍後再查詢。`,
    };
  }

  // Check if truck GPS is stale
  const lastUpdate = new Date(garbageTruck.updated_at);
  const now = new Date();
  const staleMinutes = Math.floor((now.getTime() - lastUpdate.getTime()) / 60000);
  const isStale = staleMinutes > 3;
  let staleWarning = "";
  if (isStale) {
    staleWarning = `\n⚠️ 垃圾車 GPS 已有 ${staleMinutes} 分鐘未移動或更新。`;
  }

  // Step 3: compute intermediate stops between truck's current seq and target stop seq
  const garbageSeq = garbageTruck.heading_to_stop_sequence;
  const targetSeq = nearestStop.sequence_order;
  const garbageIntermediateStops = Math.max(0, targetSeq - garbageSeq - 1);

  // Step 4: compute straight-line distance truck → target stop
  const garbageDistKm = haversineDistance(
    garbageTruck.lat,
    garbageTruck.lng,
    nearestStop.lat,
    nearestStop.lng
  );

  const garbageEtaMinutes = estimateEtaMinutes(
    garbageDistKm,
    garbageIntermediateStops,
    config.hsinchu.avgSpeedKmh,
    config.hsinchu.stopDwellSeconds
  );

  // Calculate for recycling truck if exists
  let recyclingEtaMinutes: number | undefined = undefined;
  if (recyclingTruck) {
    const recSeq = recyclingTruck.heading_to_stop_sequence;
    const recIntermediate = Math.max(0, targetSeq - recSeq - 1);
    const recDist = haversineDistance(
      recyclingTruck.lat,
      recyclingTruck.lng,
      nearestStop.lat,
      nearestStop.lng
    );
    recyclingEtaMinutes = estimateEtaMinutes(
      recDist,
      recIntermediate,
      config.hsinchu.avgSpeedKmh,
      config.hsinchu.stopDwellSeconds
    );
  }

  // now was already declared for isStale check
  
  // Async log to database for garbage truck
  const db = getSupabaseClient();
  db.from("eta_logs").insert({
    route_id: nearestStop.route_id,
    stop_id: nearestStop.sequence_order,
    car_no: garbageTruck.car_no,
    user_lat: userLat,
    user_lng: userLng,
    estimated_eta_minutes: garbageEtaMinutes,
    predicted_arrival_time: new Date(now.getTime() + garbageEtaMinutes * 60000).toISOString(),
    car_type: "0"
  }).then(({error}) => {
    if (error) console.error("[TruckService] Failed to insert garbage eta_log:", error.message);
  });

  // Async log to database for recycling truck
  if (recyclingTruck && recyclingEtaMinutes !== undefined) {
    db.from("eta_logs").insert({
      route_id: nearestStop.route_id,
      stop_id: nearestStop.sequence_order,
      car_no: recyclingTruck.car_no,
      user_lat: userLat,
      user_lng: userLng,
      estimated_eta_minutes: recyclingEtaMinutes,
      predicted_arrival_time: new Date(now.getTime() + recyclingEtaMinutes * 60000).toISOString(),
      car_type: "1"
    }).then(({error}) => {
      if (error) console.error("[TruckService] Failed to insert recycling eta_log:", error.message);
    });
  }

  // Basic message fallback (will be overridden by Line Service Flex Message anyway)
  const formattedTime = nearestStop.scheduled_time ? nearestStop.scheduled_time.slice(0, 5) : "未知";
  const message = `📍 最近清運點：${nearestStop.point_name ?? nearestStop.address}\n` +
                  `🕐 官方表定：${formattedTime}${avgStr}\n` +
                  `🚛 垃圾車：約 ${garbageEtaMinutes} 分鐘${staleWarning}` +
                  (recyclingEtaMinutes !== undefined ? `\n♻️ 回收車：約 ${recyclingEtaMinutes} 分鐘` : "");

  return {
    found: true,
    routeId: nearestStop.route_id,
    nearestStopName: nearestStop.point_name ?? undefined,
    nearestStopAddress: nearestStop.address ?? undefined,
    stopLat: nearestStop.lat,
    stopLng: nearestStop.lng,
    userLat,
    userLng,
    etaMinutes: garbageEtaMinutes,
    carNo: garbageTruck.car_no,
    truckLat: garbageTruck.lat,
    truckLng: garbageTruck.lng,
    recyclingCarNo: recyclingTruck?.car_no,
    recyclingTruckLat: recyclingTruck?.lat,
    recyclingTruckLng: recyclingTruck?.lng,
    recyclingEtaMinutes,
    scheduledTime: formattedTime,
    historicalAvgTime: historicalAvg,
    message,
    isStale,
    staleMinutes
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
