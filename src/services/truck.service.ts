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
  // Step 1: nearest stop from PostGIS
  const nearestStop = await getNearestStop(userLat, userLng);

  if (!nearestStop) {
    return {
      found: false,
      message:
        "⚠️ 找不到您附近 1.5 公里內的清運站點，請確認您已傳送正確的位置，或目前此區域今日無清運服務。",
    };
  }

  // Step 2: Fetch real-time data from HCCG directly for this specific route.
  // This is extremely fast (O(1)) and guarantees < 30s latency without blocking.
  let truckData = await syncSingleTruckFromHccg(nearestStop.route_id).catch(err => {
    console.error("[TruckService] Failed to fetch single truck:", err);
    return null;
  });

  // Fallback to Redis if API is down
  if (!truckData) {
    truckData = await getTruckLiveData(nearestStop.route_id);
  }

  if (!truckData) {
    return {
      found: true,
      routeId: nearestStop.route_id,
      nearestStopName: nearestStop.point_name ?? undefined,
      nearestStopAddress: nearestStop.address ?? undefined,
      stopLat: nearestStop.lat,
      stopLng: nearestStop.lng,
      userLat,
      userLng,
      scheduledTime: nearestStop.scheduled_time ?? undefined,
      message: `📍 找到最近的清運點：${nearestStop.point_name ?? nearestStop.address}\n` +
               `🕐 表定時間：${nearestStop.scheduled_time ?? "未知"}\n` +
               `⚠️ 目前無法取得該路線車輛的即時 GPS 訊號（可能尚未出車或訊號中斷），請稍後再查詢。`,
    };
  }

  // Step 3: compute intermediate stops between truck's current seq and target stop seq
  const truckSeq = truckData.heading_to_stop_sequence;
  const targetSeq = nearestStop.sequence_order;
  const intermediateStops = Math.max(0, targetSeq - truckSeq - 1);

  // Step 4: compute straight-line distance truck → target stop
  const distanceKm = haversineDistance(
    truckData.lat,
    truckData.lng,
    nearestStop.lat,
    nearestStop.lng
  );

  const etaMinutes = estimateEtaMinutes(
    distanceKm,
    intermediateStops,
    config.hsinchu.avgSpeedKmh,
    config.hsinchu.stopDwellSeconds
  );

  // Build human-readable message
  let etaText: string;
  if (truckSeq > targetSeq) {
    etaText = "🚛 垃圾車已通過您附近的清運點，今日已清運完畢。";
  } else if (etaMinutes <= 2) {
    etaText = "🚨 垃圾車即將抵達！請立即準備垃圾下樓！";
  } else if (etaMinutes <= 5) {
    etaText = `⏰ 垃圾車大約 ${etaMinutes} 分鐘後抵達，請準備！`;
  } else {
    etaText = `⏳ 預估約 ${etaMinutes} 分鐘後抵達您附近。`;
  }

  const now = new Date();
  const predictedArrivalTime = new Date(now.getTime() + etaMinutes * 60000).toISOString();

  // Async log to database (fire and forget to not block the user response)
  const db = getSupabaseClient();
  db.from("eta_logs").insert({
    route_id: nearestStop.route_id,
    stop_id: nearestStop.sequence_order,
    car_no: truckData.car_no,
    user_lat: userLat,
    user_lng: userLng,
    estimated_eta_minutes: etaMinutes,
    predicted_arrival_time: predictedArrivalTime
  }).then(({error}) => {
    if (error) console.error("[TruckService] Failed to insert eta_log:", error.message);
  });

  return {
    found: true,
    routeId: nearestStop.route_id,
    nearestStopName: nearestStop.point_name ?? undefined,
    nearestStopAddress: nearestStop.address ?? undefined,
    stopLat: nearestStop.lat,
    stopLng: nearestStop.lng,
    userLat,
    userLng,
    etaMinutes,
    carNo: truckData.car_no,
    truckLat: truckData.lat,
    truckLng: truckData.lng,
    scheduledTime: nearestStop.scheduled_time ?? undefined,
    message:
      `📍 最近清運點：${nearestStop.point_name ?? nearestStop.address}\n` +
      `🕐 表定時間：${nearestStop.scheduled_time ?? "未知"}\n` +
      `🚛 車牌：${truckData.car_no ?? "未知"}\n` +
      etaText,
  };
}

// ── HCCG API sync ────────────────────────────────────────────

/**
 * Fetches the latest GPS position for a SINGLE vehicle route from the HCCG API.
 * This is incredibly fast and avoids the heavy lifting of parsing all 130+ trucks.
 * Saves to Redis and resolves ETA logs asynchronously.
 */
export async function syncSingleTruckFromHccg(routeId: string): Promise<TruckLiveData | null> {
  const url = `${config.hccg.baseUrl}/getCarLocation?rId=${routeId}`;

  const response = await fetch(url, {
    headers: {
      Referer: config.hccg.referer,
      "User-Agent": "EcoTrack-Bot/1.0",
    },
    signal: AbortSignal.timeout(5_000), // very short timeout for UX
  });

  if (!response.ok) return null;

  const json = (await response.json()) as HccgApiResponse<HccgCarLocationData>;
  if (json.statusCode !== 1 || !json.data || json.data.car.length === 0) return null;

  const car = json.data.car[0];
  const lat = parseFloat(car.lat);
  const lng = parseFloat(car.lon);

  if (!isValidCoordinate(lat, lng)) return null;

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
  };

  // Async save to Redis
  setTruckLiveData(car.routeId, liveData).catch(console.error);

  // Async resolve ETA logs
  const currentSeq = parseInt(car.seq, 10);
  if (!isNaN(currentSeq) && currentSeq > 0) {
    const db = getSupabaseClient();
    db.from("eta_logs")
      .update({ actual_arrival_time: liveData.updated_at })
      .eq("route_id", car.routeId)
      .is("actual_arrival_time", null)
      .lte("stop_id", currentSeq)
      .then(({error}) => {
        if (error) console.error("[TruckService] Failed to resolve eta_logs:", error.message);
      });
  }

  return liveData;
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
  const routeIds = [...new Set(cars.map((c) => c.routeId))];
  await Promise.all(
    routeIds.map(async (rid) => {
      const existing = await getTruckLiveData(rid);
      if (existing) previousCache.set(rid, existing);
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
      const prev = previousCache.get(car.routeId);
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
      };

      await setTruckLiveData(car.routeId, liveData);
      
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
