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
import { getNextScheduledArrival, SCHEDULE_LATE_GRACE_MINUTES, formatEtaClock } from "../utils/time.util.js";
import {
  applyEtaBias,
  clampEtaBiasMinutes,
  isSchedulePastGrace,
  isSequencePastStop,
  type EtaSource,
} from "../utils/eta-policy.util.js";
import { clampRadiusMeters, type LocateMode } from "./prefs.service.js";
import { formatAreaWeekSchedule } from "./schedule.service.js";
import { recommendNearbyStop } from "../utils/nearby-stops.util.js";
import { streetAffinityScore } from "../utils/street-match.util.js";
import { pickEarliestNextArrival } from "../utils/area-next-arrival.util.js";

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

// Stale threshold: GPS older than 6 hours is considered "today unavailable"
// (Truck ran earlier / yesterday, GPS off now — don't mislead with fake ETAs)
const STALE_THRESHOLD_MS = 6 * 60 * 60 * 1000;
// Soft warning: GPS older than this still usable for ETA, but UI should warn.
const STALE_WARN_MS = 15 * 60 * 1000;

const DEFAULT_GARBAGE_DAYS = [1, 2, 4, 5, 6] as const;
const OFFICIAL_LIVE_STATUS = "1";
const CAR_STATUS_DONE = "1";
// When primary route has no live signal, try other nearby stops within this radius.
const ALT_ROUTE_RADIUS_M = 100;

export interface CalculateEtaOptions {
  locateMode?: LocateMode;
  radiusMeters?: number;
  /** Doorplate — prefer same-street main-road pins over nearer alleys */
  homeAddress?: string;
}

function buildSearchRadii(preferredMeters: number): number[] {
  const base = clampRadiusMeters(preferredMeters);
  return [...new Set([base, Math.min(500, base + 100), Math.min(500, base + 200), 500])];
}

const POINTS_CACHE_KEY = (
  lat: number,
  lng: number,
  radius: number,
  mode: LocateMode
) => `points_cache:${lat.toFixed(4)}:${lng.toFixed(4)}:r${radius}:${mode}`;

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

function hasServiceToday(
  daysString: string | null | undefined,
  defaultDays?: readonly number[]
): boolean {
  const weekday = getTaiwanWeekday();
  const parsed = (daysString ?? "")
    .split(",")
    .map((value) => parseInt(value, 10))
    .filter((value) => !Number.isNaN(value) && value >= 1 && value <= 7);

  if (parsed.length > 0) return parsed.includes(weekday);
  if (defaultDays && defaultDays.length > 0) return defaultDays.includes(weekday);
  return false;
}

function getMinutesUntilScheduled(scheduledTime: string | null): number | null {
  if (!scheduledTime) return null;

  const [hours, minutes] = scheduledTime.split(":").map(Number);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;

  return hours * 60 + minutes - getTaiwanMinutesOfDay();
}

/**
 * Prefer the government's own live estimate whenever it is present.
 * Empty trashDay/recycleDay should not block a live estimate; only an
 * explicit "not today" day list should.
 */
function getOfficialEtaMinutes(
  point: HccgCleanPoint,
  carType: "0" | "1"
): number | undefined {
  if (point.status !== OFFICIAL_LIVE_STATUS) return undefined;

  const estimateSeconds = parseInt(point.estimate, 10);
  if (Number.isNaN(estimateSeconds) || estimateSeconds < 0) return undefined;

  const dayField = carType === "0" ? point.trashDay : point.recycleDay;
  const defaultDays = carType === "0" ? DEFAULT_GARBAGE_DAYS : undefined;
  const rawDays = dayField?.trim();

  // Explicit day list that excludes today → not this vehicle's service.
  if (rawDays && !hasServiceToday(dayField, defaultDays)) return undefined;

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
    hasTodayGarbage: hasServiceToday(point.trashDay, DEFAULT_GARBAGE_DAYS),
    hasTodayRecycling: hasServiceToday(point.recycleDay),
  };
}

function getCandidateTimePenalty(candidate: NearbyPointCandidate): number {
  const diff = candidate.minutesUntilScheduled;
  if (diff === null) return 3000;
  // Far past the late-grace window → heavily deprioritize.
  if (diff < -SCHEDULE_LATE_GRACE_MINUTES) return 6000 + Math.abs(diff);
  // Mildly late (common for Hsinchu trucks): keep as a strong candidate.
  if (diff < 0) return Math.abs(diff);
  if (diff > 240) return 1000 + diff;
  return Math.abs(diff);
}

function comparePointCandidates(
  left: NearbyPointCandidate,
  right: NearbyPointCandidate,
  locateMode: LocateMode = "recommend"
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

  // Official "全部顯示": prioritize pure distance. "自動/推薦": keep schedule proximity.
  if (locateMode === "all_day") {
    return left.distanceMeters - right.distanceMeters;
  }

  const timePenaltyDelta =
    getCandidateTimePenalty(left) - getCandidateTimePenalty(right);
  if (timePenaltyDelta !== 0) return timePenaltyDelta;

  return left.distanceMeters - right.distanceMeters;
}

async function fetchNearbyPointsFromHccg(
  userLat: number,
  userLng: number,
  radii: number[],
  locateMode: LocateMode
): Promise<HccgCleanPoint[]> {
  let lastError: Error | null = null;
  // Official locatemode: 1 ≈ auto/recommend by time; 0 ≈ show all in range.
  const locatemode = locateMode === "all_day" ? "0" : "1";

  for (const radius of radii) {
    try {
      const params = new URLSearchParams({
        lat: userLat.toString(),
        lon: userLng.toString(),
        range: radius.toString(),
        locatemode,
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
 */
async function fetchNearbyPointsCached(
  userLat: number,
  userLng: number,
  radiusMeters: number,
  _locateMode: LocateMode
): Promise<HccgCleanPoint[]> {
  // Always fetch locatemode=0 (all in range). Ranking by「推薦／整天」is done in JS.
  // Otherwise 定位 vs 最愛（或垃圾車 vs 附近）會因官方 API 回不同子集而建議不同清運點。
  const fetchMode: LocateMode = "all_day";
  const redis = getRedis();
  const cacheKey = POINTS_CACHE_KEY(userLat, userLng, radiusMeters, fetchMode);

  try {
    const cached = await redis.get<HccgCleanPoint[]>(cacheKey);
    if (cached && cached.length > 0) return cached;
  } catch (error) {
    console.error("[TruckService] Nearby points cache read failed:", error);
  }

  const points = await fetchNearbyPointsFromHccg(
    userLat,
    userLng,
    buildSearchRadii(radiusMeters),
    fetchMode
  );

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
 * Resolves ranked nearby clean points for a coordinate.
 * Shared by calculateEta (incl. alt-route fallback) and route-switch detection.
 */
async function selectNearbyCandidates(
  userLat: number,
  userLng: number,
  options: CalculateEtaOptions = {}
): Promise<NearbyPointCandidate[]> {
  const locateMode = options.locateMode ?? "recommend";
  const radiusMeters = clampRadiusMeters(options.radiusMeters ?? 100);
  let nearbyPoints: HccgCleanPoint[] = [];

  try {
    nearbyPoints = await fetchNearbyPointsCached(
      userLat,
      userLng,
      radiusMeters,
      locateMode
    );
  } catch (error) {
    console.error("[TruckService] Failed to fetch nearby points:", error);
  }

  if (nearbyPoints.length === 0) return [];

  return nearbyPoints
    .map((point) => buildPointCandidate(userLat, userLng, point))
    .sort((a, b) => comparePointCandidates(a, b, locateMode));
}

async function selectNearbyCandidate(
  userLat: number,
  userLng: number,
  options: CalculateEtaOptions = {}
): Promise<NearbyPointCandidate | null> {
  const candidates = await selectNearbyCandidates(userLat, userLng, options);
  return candidates[0] ?? null;
}

async function loadLiveTrucksForRoute(routeId: string): Promise<{
  garbage: TruckLiveData | null;
  recycling: TruckLiveData | null;
}> {
  let truckData = await syncSingleTruckFromHccg(routeId).catch((error) => {
    console.error("[TruckService] Failed to fetch single truck:", error);
    return { garbage: null, recycling: null };
  });

  truckData = {
    garbage: sanitizeLiveTruck(truckData.garbage),
    recycling: sanitizeLiveTruck(truckData.recycling),
  };

  if (!truckData.garbage) {
    truckData.garbage = await getRecentTruckFallback(routeId, "0");
  }
  if (!truckData.recycling) {
    truckData.recycling = await getRecentTruckFallback(routeId, "1");
  }

  return truckData;
}

function candidateHasOfficialEta(candidate: NearbyPointCandidate): boolean {
  return (
    candidate.garbageEtaMinutes !== undefined ||
    candidate.recyclingEtaMinutes !== undefined
  );
}

/**
 * Resolves the route a user's location currently maps to, via the official
 * nearby-point API. Used for route-switch detection when a user moves.
 */
export async function resolveNearestRoute(
  userLat: number,
  userLng: number,
  options: CalculateEtaOptions = {}
): Promise<{ routeId: string; routeName: string } | null> {
  const candidate = await selectNearbyCandidate(userLat, userLng, options);
  if (!candidate) return null;

  return {
    routeId: candidate.point.routeId,
    routeName: candidate.point.routeName,
  };
}

/**
 * Keyword / address / route search — mirrors official site filters, but returns
 * a ranked LINE-friendly summary with schedule + distance when coords known.
 */
export async function searchCleanPointsByKeyword(
  keyword: string,
  userLat?: number,
  userLng?: number
): Promise<string> {
  const q = keyword.trim();
  if (!q) return "請輸入關鍵字，例如：查 中正路、查 東門、查 香山大庄";

  const params = new URLSearchParams({ address: q });
  const response = await fetch(
    `${config.hccg.baseUrl}/getPointData?${params.toString()}`,
    {
      headers: {
        Referer: config.hccg.referer,
        "User-Agent": "EcoTrack-Bot/1.0",
      },
      signal: AbortSignal.timeout(8_000),
    }
  );

  if (!response.ok) {
    return "⚠️ 官方班表服務暫時無法搜尋，請稍後再試。";
  }

  const json = (await response.json()) as HccgApiResponse<HccgCleanPointData>;
  if (json.statusCode !== 1 || !json.data?.cleanPoint?.length) {
    return `🔍 找不到「${q}」相關清運點。\n試試更短的路名／地標，或傳 GPS 讓我依位置推薦。`;
  }

  const points = json.data.cleanPoint
    .filter((p) => isValidCoordinate(parseFloat(p.lat), parseFloat(p.lon)))
    .slice(0, 80);

  const scored = points.map((point) => {
    const lat = parseFloat(point.lat);
    const lng = parseFloat(point.lon);
    const distanceMeters =
      userLat !== undefined && userLng !== undefined
        ? haversineDistance(userLat, userLng, lat, lng) * 1000
        : Number.POSITIVE_INFINITY;
    return { point, distanceMeters };
  });

  scored.sort((a, b) => a.distanceMeters - b.distanceMeters);
  const top = scored.slice(0, 5);

  const lines = top.map((item, idx) => {
    const p = item.point;
    const time = parseScheduledTime(p.time) ?? p.time ?? "未知";
    const dist =
      Number.isFinite(item.distanceMeters) && item.distanceMeters < 50_000
        ? `｜距你約 ${Math.round(item.distanceMeters)}m`
        : "";
    return (
      `${idx + 1}. ${p.pointName || p.address}\n` +
      `   路線 ${p.routeName}｜表定 ${time}${dist}\n` +
      `   垃圾：${p.trashDay || "?"}｜回收：${p.recycleDay || "?"}`
    );
  });

  return (
    `🔍 搜尋「${q}」（優於官方：可搭配你的位置排序）\n\n` +
    lines.join("\n\n") +
    `\n\n💡 傳「班表」看住家整週；傳「垃圾車」追即時 ETA；靠近 5 分鐘會推播。`
  );
}

/**
 * Build a weekly schedule card for the user's coordinate.
 * Lists nearby stops' times (area-wide) so afternoon routes aren't hidden
 * behind a single evening pin.
 */
export async function getScheduleCardForLocation(
  userLat: number,
  userLng: number,
  options: CalculateEtaOptions = {}
): Promise<string> {
  const radiusMeters = clampRadiusMeters(options.radiusMeters ?? 100);
  // Expand a bit so we see afternoon + evening pins on the same street.
  const searchRadius = Math.max(radiusMeters, 200);
  const candidates = await selectNearbyCandidates(userLat, userLng, {
    ...options,
    locateMode: "all_day",
    radiusMeters: searchRadius,
  });

  const inRange = candidates
    .filter((c) => c.distanceMeters <= searchRadius)
    .sort((a, b) => a.distanceMeters - b.distanceMeters);

  if (inRange.length === 0) {
    return "⚠️ 附近找不到清運點，請先傳送 GPS 或傳「查 路名」搜尋。";
  }

  const homeAddress = options.homeAddress;
  const ranked = [...inRange].sort((a, b) => {
    const sa = streetAffinityScore(
      homeAddress,
      a.point.pointName || "",
      a.point.address || ""
    );
    const sb = streetAffinityScore(
      homeAddress,
      b.point.pointName || "",
      b.point.address || ""
    );
    return sb - sa || a.distanceMeters - b.distanceMeters;
  });

  const rows = ranked.slice(0, 10).map((c) => {
    const name = c.point.pointName || c.point.address || "清運點";
    const next = getNextScheduledArrival(
      c.point.trashDay,
      c.scheduledTime,
      isSchedulePastGrace(
        c.hasTodayGarbage,
        c.minutesUntilScheduled
      ),
      [...DEFAULT_GARBAGE_DAYS]
    );
    return {
      name,
      distanceMeters: Math.round(c.distanceMeters),
      scheduledTime: c.scheduledTime,
      trashDays: c.point.trashDay,
      recycleDays: c.point.recycleDay,
      nextArrival: next?.dateStr,
      streetScore: streetAffinityScore(
        homeAddress,
        c.point.pointName || "",
        c.point.address || ""
      ),
    };
  });

  const earliest = pickEarliestNextArrival(
    ranked.map((c) => ({
      id: `${c.point.routeId}:${c.point.seq}`,
      name: c.point.pointName || c.point.address || "清運點",
      daysString: c.point.trashDay,
      scheduledTime: c.scheduledTime,
      hasPassedToday: isSchedulePastGrace(
        c.hasTodayGarbage,
        c.minutesUntilScheduled
      ),
      defaultDays: [...DEFAULT_GARBAGE_DAYS],
    }))
  );

  return formatAreaWeekSchedule({
    radiusMeters: searchRadius,
    homeAddress,
    earliestNext: earliest
      ? `${earliest.dateStr}（${earliest.stopName}）`
      : undefined,
    stops: rows,
  });
}

export interface NearbyStopGuideItem {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  distanceMeters: number;
  scheduledTime: string | null;
  minutesUntilScheduled: number | null;
  status: "live" | "upcoming" | "passed" | "no_service";
  statusLabel: string;
  etaMinutes?: number;
  nextArrival?: string;
}

export interface NearbyStopsGuide {
  radiusMeters: number;
  userLat: number;
  userLng: number;
  recommend: NearbyStopGuideItem | null;
  recommendReason: string;
  /** Earliest next garbage pickup among nearby stops (may differ from recommend) */
  areaNextArrival?: string;
  nearest: NearbyStopGuideItem | null;
  soonest: NearbyStopGuideItem | null;
  stops: NearbyStopGuideItem[];
  message: string;
}

function candidateToGuideItem(c: NearbyPointCandidate): NearbyStopGuideItem {
  const name = c.point.pointName || c.point.address || "清運點";
  const address = c.point.address || name;
  const etaMinutes = c.garbageEtaMinutes ?? c.recyclingEtaMinutes;
  const hasToday = c.hasTodayGarbage || c.hasTodayRecycling;
  const passed = isSchedulePastGrace(hasToday, c.minutesUntilScheduled);

  let status: NearbyStopGuideItem["status"];
  let statusLabel: string;
  if (etaMinutes !== undefined) {
    status = "live";
    statusLabel = `預估約 ${etaMinutes} 分後到（約 ${formatEtaClock(etaMinutes)}）`;
  } else if (!hasToday) {
    status = "no_service";
    statusLabel = "今日無收運";
  } else if (passed) {
    status = "passed";
    statusLabel = "今日已過站";
  } else if (c.minutesUntilScheduled !== null && c.minutesUntilScheduled < 0) {
    status = "upcoming";
    statusLabel = `表定已過 ${Math.abs(c.minutesUntilScheduled)} 分（可能延誤中）`;
  } else if (c.minutesUntilScheduled !== null) {
    status = "upcoming";
    statusLabel = `表定約 ${c.minutesUntilScheduled} 分後（約 ${formatEtaClock(c.minutesUntilScheduled)}）`;
  } else {
    status = "upcoming";
    statusLabel = "今日有班（時間未知）";
  }

  const nextInfo = getNextScheduledArrival(
    c.point.trashDay,
    c.scheduledTime,
    status === "passed" || status === "no_service",
    [...DEFAULT_GARBAGE_DAYS]
  );

  return {
    id: `${c.point.routeId}:${c.point.seq}:${c.point.pointId || name}`,
    name,
    address,
    lat: parseFloat(c.point.lat),
    lng: parseFloat(c.point.lon),
    distanceMeters: Math.round(c.distanceMeters),
    scheduledTime: c.scheduledTime,
    minutesUntilScheduled: c.minutesUntilScheduled,
    status,
    statusLabel,
    etaMinutes,
    nextArrival: nextInfo?.dateStr,
  };
}

/**
 * If HCCG has no live estimate yet, try truck GPS → ETA to this stop.
 * Same-day recommendations should show arrival estimate, not only 表定.
 */
async function enrichGuideItemWithLiveEta(
  item: NearbyStopGuideItem,
  candidate: NearbyPointCandidate
): Promise<NearbyStopGuideItem> {
  if (item.etaMinutes !== undefined) {
    return {
      ...item,
      status: "live",
      statusLabel: `預估約 ${item.etaMinutes} 分後到（約 ${formatEtaClock(item.etaMinutes)}）`,
    };
  }
  if (item.status === "passed" || item.status === "no_service") return item;
  if (!candidate.hasTodayGarbage && !candidate.hasTodayRecycling) return item;

  try {
    const truckData = await loadLiveTrucksForRoute(candidate.point.routeId);
    const truck = truckData.garbage ?? truckData.recycling;
    if (!truck) return item;

    const seq = parseInt(candidate.point.seq, 10) || 0;
    if (isSequencePastStop(truck.heading_to_stop_sequence, seq)) {
      return {
        ...item,
        status: "passed",
        statusLabel: "即時判斷：車已過此站",
        etaMinutes: undefined,
      };
    }

    const etaMinutes = Math.max(
      1,
      Math.round(estimateEtaFromTruck(truck, item.lat, item.lng, seq))
    );
    return {
      ...item,
      etaMinutes,
      status: "live",
      statusLabel: `預估約 ${etaMinutes} 分後到（約 ${formatEtaClock(etaMinutes)}）`,
    };
  } catch (err) {
    console.error("[TruckService] enrich live ETA failed:", err);
    return item;
  }
}

/**
 * List clean points near a target with times, and recommend:
 * same-street main-road when possible; area-wide earliest next when today is done.
 */
export async function getNearbyStopsGuide(
  userLat: number,
  userLng: number,
  options: CalculateEtaOptions = {}
): Promise<NearbyStopsGuide> {
  const radiusMeters = clampRadiusMeters(options.radiusMeters ?? 100);
  // Widen slightly so afternoon + evening pins on the same street stay visible.
  const searchRadius = Math.max(radiusMeters, 150);
  const homeAddress = options.homeAddress;
  const candidates = await selectNearbyCandidates(userLat, userLng, {
    ...options,
    locateMode: options.locateMode ?? "all_day",
    radiusMeters: searchRadius,
  });

  const inRange = candidates
    .filter((c) => c.distanceMeters <= searchRadius)
    .sort((a, b) => a.distanceMeters - b.distanceMeters);

  const pool = (inRange.length > 0 ? inRange : candidates.slice(0, 8)).slice(
    0,
    12
  );
  const stops = pool.map(candidateToGuideItem);

  if (stops.length === 0) {
    return {
      radiusMeters,
      userLat,
      userLng,
      recommend: null,
      recommendReason: "",
      nearest: null,
      soonest: null,
      stops: [],
      message:
        `⚠️ 方圓 ${radiusMeters}m 找不到清運點。\n` +
        `可傳「半徑 200」加大範圍，或「查 路名」搜尋。`,
    };
  }

  const areaEarliest = pickEarliestNextArrival(
    pool.map((c, i) => ({
      id: stops[i].id,
      name: stops[i].name,
      daysString: c.point.trashDay,
      scheduledTime: c.scheduledTime,
      hasPassedToday:
        stops[i].status === "passed" || stops[i].status === "no_service",
      defaultDays: [...DEFAULT_GARBAGE_DAYS],
    }))
  );

  const nextKeyById = new Map<string, number>();
  for (let i = 0; i < stops.length; i++) {
    const one = pickEarliestNextArrival([
      {
        id: stops[i].id,
        name: stops[i].name,
        daysString: pool[i].point.trashDay,
        scheduledTime: stops[i].scheduledTime,
        hasPassedToday:
          stops[i].status === "passed" || stops[i].status === "no_service",
        defaultDays: [...DEFAULT_GARBAGE_DAYS],
      },
    ]);
    if (one) nextKeyById.set(stops[i].id, one.sortKey);
  }

  const pick = recommendNearbyStop(
    stops.map((s) => ({
      id: s.id,
      distanceMeters: s.distanceMeters,
      etaMinutes: s.etaMinutes,
      minutesUntilScheduled: s.minutesUntilScheduled,
      hasTodayService: s.status !== "no_service",
      status: s.status,
      streetScore: streetAffinityScore(homeAddress, s.name, s.address),
      nextSortKey: nextKeyById.get(s.id),
    }))
  );

  let recommend =
    (pick && stops.find((s) => s.id === pick.stop.id)) || stops[0];
  let recommendReason = pick?.reason ?? "最近清運點";

  // Surface area-wide earliest next on the recommend card (don't hide afternoon).
  if (
    areaEarliest &&
    (!recommend.nextArrival ||
      areaEarliest.dateStr !== recommend.nextArrival)
  ) {
    recommend = {
      ...recommend,
      nextArrival: areaEarliest.dateStr,
    };
    if (
      areaEarliest.stopId !== recommend.id &&
      (recommend.status === "passed" || recommend.status === "no_service")
    ) {
      const better = stops.find((s) => s.id === areaEarliest.stopId);
      if (better) {
        recommend = {
          ...better,
          nextArrival: areaEarliest.dateStr,
        };
        recommendReason = `附近下次最早在「${better.name}」`;
      }
    } else if (areaEarliest.stopId !== recommend.id) {
      recommendReason =
        `${recommendReason}；附近最早班次：${areaEarliest.dateStr}（${areaEarliest.stopName}）`;
    }
  }

  // Same-day: attach live ETA to recommended stop (and matching list row).
  const recIdx = stops.findIndex((s) => s.id === recommend.id);
  const recCandidate = recIdx >= 0 ? pool[recIdx] : undefined;
  if (recCandidate) {
    recommend = await enrichGuideItemWithLiveEta(recommend, recCandidate);
    if (recIdx >= 0) stops[recIdx] = recommend;
  }

  // Also enrich a few other upcoming stops that lack official live ETA.
  await Promise.all(
    stops.slice(0, 5).map(async (s, i) => {
      if (s.id === recommend.id) return;
      if (s.status !== "live" && s.status !== "upcoming") return;
      if (s.etaMinutes !== undefined) return;
      stops[i] = await enrichGuideItemWithLiveEta(s, pool[i]);
    })
  );

  const nearest = [...stops].sort(
    (a, b) => a.distanceMeters - b.distanceMeters
  )[0];
  const soonestUseful = [...stops]
    .filter((s) => s.status === "live" || s.status === "upcoming")
    .sort((a, b) => {
      const ak = a.etaMinutes ?? Number.POSITIVE_INFINITY;
      const bk = b.etaMinutes ?? Number.POSITIVE_INFINITY;
      if (ak !== bk) return ak - bk;
      return a.distanceMeters - b.distanceMeters;
    })[0] ?? null;

  const lines = [
    `📍 方圓 ${searchRadius}m 清運點（共 ${stops.length} 處）`,
    ``,
    `⭐ 建議：${recommend.name}（${recommend.distanceMeters}m）`,
    `   ${recommendReason}`,
    `   表定 ${recommend.scheduledTime ?? "未知"}｜${recommend.statusLabel}`,
    recommend.etaMinutes !== undefined
      ? `   ⏱ 預估抵達推薦點：約 ${recommend.etaMinutes} 分後（${formatEtaClock(recommend.etaMinutes)}）`
      : null,
    areaEarliest
      ? `   附近下次最早：${areaEarliest.dateStr}（${areaEarliest.stopName}）`
      : recommend.nextArrival
        ? `   下次：${recommend.nextArrival}`
        : null,
    ``,
    `清單：`,
    ...stops.map((s, i) => {
      const mark = s.id === recommend.id ? "👉" : `${i + 1}.`;
      return (
        `${mark} ${s.name}｜${s.distanceMeters}m\n` +
        `   表定 ${s.scheduledTime ?? "?"}｜${s.statusLabel}` +
        (s.nextArrival && s.status !== "live" && s.status !== "upcoming"
          ? `\n   下次 ${s.nextArrival}`
          : "")
      );
    }),
    ``,
    nearest && soonestUseful && nearest.id !== soonestUseful.id
      ? `📌 最近：${nearest.name}（${nearest.distanceMeters}m）｜最快：${soonestUseful.name}（${soonestUseful.distanceMeters}m）`
      : null,
    `💡 同一條街常有下午＋晚上多班；以「附近下次最早」為準。車常沿主街收，不必走進巷內。`,
  ].filter((line): line is string => line !== null);

  return {
    radiusMeters: searchRadius,
    userLat,
    userLng,
    recommend,
    recommendReason,
    areaNextArrival: areaEarliest?.dateStr,
    nearest,
    soonest: soonestUseful,
    stops,
    message: lines.join("\n"),
  };
}

function getTruckAgeMs(truck: TruckLiveData): number {
  const updatedAt = new Date(truck.updated_at).getTime();
  if (Number.isNaN(updatedAt)) return Number.POSITIVE_INFINITY;
  return Date.now() - updatedAt;
}

/**
 * Drops GPS that cannot produce a trustworthy live ETA.
 * HCCG often keeps returning yesterday's last ping with seq=-1 after service ends.
 */
function sanitizeLiveTruck(truck: TruckLiveData | null): TruckLiveData | null {
  if (!truck) return null;
  if (getTruckAgeMs(truck) >= STALE_THRESHOLD_MS) return null;
  if (truck.heading_to_stop_sequence < 0) return null;
  if (truck.status === CAR_STATUS_DONE) return null;
  return truck;
}

async function getRecentTruckFallback(
  routeId: string,
  carType: "0" | "1"
): Promise<TruckLiveData | null> {
  const fallback = carType === "0"
    ? (await getTruckLiveData(`${routeId}:0`)) ??
      (await getTruckLiveData(routeId))
    : await getTruckLiveData(`${routeId}:1`);

  return sanitizeLiveTruck(fallback);
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
  userLng: number,
  options: CalculateEtaOptions = {}
): Promise<EtaResult> {
  const locateMode = options.locateMode ?? "recommend";
  const radiusMeters = clampRadiusMeters(options.radiusMeters ?? 100);
  const homeAddress = options.homeAddress;
  const candidates = await selectNearbyCandidates(userLat, userLng, {
    locateMode,
    radiusMeters: Math.max(radiusMeters, 150),
  });

  // Prefer same-street main-road pin over a slightly closer alley pin.
  let candidate = candidates[0];
  if (homeAddress && candidates.length > 1) {
    const ranked = [...candidates].sort((a, b) => {
      const sa = streetAffinityScore(
        homeAddress,
        a.point.pointName || "",
        a.point.address || ""
      );
      const sb = streetAffinityScore(
        homeAddress,
        b.point.pointName || "",
        b.point.address || ""
      );
      return sb - sa || a.distanceMeters - b.distanceMeters;
    });
    const best = ranked[0];
    const bestScore = streetAffinityScore(
      homeAddress,
      best.point.pointName || "",
      best.point.address || ""
    );
    if (
      bestScore >= 100 &&
      best.distanceMeters <= (candidates[0]?.distanceMeters ?? 0) + 120
    ) {
      candidate = best;
    }
  }

  if (!candidate) {
    return {
      found: false,
      message:
        "⚠️ 找不到您附近的清運點，請確認 GPS 位置是否正確，或改在表定時間前後再查一次。\n💡 也可傳「半徑 200」加大搜尋範圍（50–500，官方預設 100）。",
      locateMode,
      radiusMeters,
    };
  }

  let truckData = await loadLiveTrucksForRoute(candidate.point.routeId);
  let usedAlternateRoute = false;

  const primaryHasSignal =
    candidateHasOfficialEta(candidate) ||
    Boolean(truckData.garbage || truckData.recycling);

  // Alt-route fallback: if primary has no live signal, try other stops ≤100m away.
  if (!primaryHasSignal) {
    for (const alt of candidates.slice(1)) {
      if (alt.distanceMeters > ALT_ROUTE_RADIUS_M) continue;
      if (alt.point.routeId === candidate.point.routeId) continue;

      const altTrucks = await loadLiveTrucksForRoute(alt.point.routeId);
      if (
        candidateHasOfficialEta(alt) ||
        altTrucks.garbage ||
        altTrucks.recycling
      ) {
        console.log(
          `[TruckService] Switched to alt route ${alt.point.routeId} (${alt.distanceMeters.toFixed(0)}m)`
        );
        candidate = alt;
        truckData = altTrucks;
        usedAlternateRoute = true;
        break;
      }
    }
  }

  const point = candidate.point;
  let routeId = point.routeId;
  let stopLat = parseFloat(point.lat);
  let stopLng = parseFloat(point.lon);
  let targetSequence = parseInt(point.seq, 10) || 0;
  let formattedTime = candidate.scheduledTime ?? "未知";
  let stopName = point.pointName || point.address;
  const weekday = getTaiwanWeekday();

  // Prefer the point ON this truck's full route that is closest to home
  // (along-route collection often isn't the official "nearest clean point").
  try {
    const onRoute = await findClosestDbStopOnRoute(routeId, userLat, userLng);
    if (onRoute) {
      stopLat = onRoute.lat;
      stopLng = onRoute.lng;
      targetSequence = onRoute.seq || targetSequence;
      stopName = onRoute.name || stopName;
      if (onRoute.scheduledTime) formattedTime = onRoute.scheduledTime;
      point.pointName = stopName;
      point.address = onRoute.address || point.address;
    }
  } catch (err) {
    console.error("[TruckService] closest-on-route override failed:", err);
  }

  const nearbyUncleared = candidates
    .filter((c) => c.hasTodayGarbage || c.hasTodayRecycling)
    .filter((c) => c.distanceMeters <= radiusMeters)
    .slice(0, 12)
    .map((c) => ({
      name: c.point.pointName || c.point.address,
      lat: parseFloat(c.point.lat),
      lng: parseFloat(c.point.lon),
      scheduledTime: c.scheduledTime ?? undefined,
    }));

  // Beat official banner: explicit no-service day with next pickup.
  if (!candidate.hasTodayGarbage && !candidate.hasTodayRecycling) {
    const areaNext = pickEarliestNextArrival(
      candidates.slice(0, 15).map((c) => ({
        id: `${c.point.routeId}:${c.point.seq}`,
        name: c.point.pointName || c.point.address || "清運點",
        daysString: c.point.trashDay,
        scheduledTime: c.scheduledTime,
        hasPassedToday: true,
        defaultDays: [...DEFAULT_GARBAGE_DAYS],
      }))
    );
    const nextGarbageInfo = areaNext
      ? { dateStr: areaNext.dateStr, isToday: areaNext.isToday }
      : getNextScheduledArrival(
          point.trashDay,
          candidate.scheduledTime,
          true,
          [...DEFAULT_GARBAGE_DAYS]
        );
    const nextRecycleInfo = getNextScheduledArrival(
      point.recycleDay,
      candidate.scheduledTime,
      true
    );
    const nextStopHint =
      areaNext && areaNext.stopName !== stopName
        ? `（${areaNext.stopName}）`
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
      nextGarbageDate: nextGarbageInfo?.dateStr,
      nextRecycleDate: nextRecycleInfo?.dateStr,
      isGarbagePassed: true,
      isRecyclePassed: true,
      noServiceToday: true,
      weekday,
      trashDays: point.trashDay,
      recycleDays: point.recycleDay,
      locateMode,
      radiusMeters,
      nearbyUncleared: [],
      message:
        `🚫 今日無收運服務（優於官方：直接給下次時間）\n` +
        `📍 ${stopName}\n` +
        `🕐 表定：${formattedTime}\n` +
        (nextGarbageInfo
          ? `🚛 下次垃圾車：${nextGarbageInfo.dateStr}${nextStopHint}\n`
          : "") +
        (nextRecycleInfo ? `♻️ 下次回收車：${nextRecycleInfo.dateStr}\n` : "") +
        `\n💡 傳「班表」看附近多個時段；有班日會在車距約 5 分鐘時主動推播。`,
    };
  }

  const historicalAvg =
    targetSequence > 0
      ? await getHistoricalAverage(routeId, targetSequence)
      : undefined;
  const historicalReference = historicalAvg ?? (point.historyTime || undefined);
  const etaBias =
    targetSequence > 0
      ? await getEtaErrorBiasMinutes(routeId, targetSequence)
      : 0;

  const garbageTruck = truckData.garbage;
  const recyclingTruck = truckData.recycling;

  let garbageEtaSource: EtaSource | undefined;
  let recyclingEtaSource: EtaSource | undefined;

  let garbageEtaMinutes: number | undefined;
  if (candidate.garbageEtaMinutes !== undefined) {
    garbageEtaMinutes = candidate.garbageEtaMinutes;
    garbageEtaSource = "official";
  } else if (garbageTruck) {
    garbageEtaMinutes = applyEtaBias(
      estimateEtaFromTruck(garbageTruck, stopLat, stopLng, targetSequence),
      etaBias
    );
    garbageEtaSource = "estimated";
  }

  let recyclingEtaMinutes: number | undefined;
  if (candidate.recyclingEtaMinutes !== undefined) {
    recyclingEtaMinutes = candidate.recyclingEtaMinutes;
    recyclingEtaSource = "official";
  } else if (recyclingTruck) {
    recyclingEtaMinutes = applyEtaBias(
      estimateEtaFromTruck(recyclingTruck, stopLat, stopLng, targetSequence),
      etaBias
    );
    recyclingEtaSource = "estimated";
  }

  const liveTruckForStale = garbageTruck ?? recyclingTruck;
  const staleMinutes = liveTruckForStale
    ? Math.max(0, Math.round(getTruckAgeMs(liveTruckForStale) / 60_000))
    : 0;
  const isStale = liveTruckForStale
    ? getTruckAgeMs(liveTruckForStale) >= STALE_WARN_MS
    : false;

  const isGarbagePassed =
    candidate.garbageEtaMinutes === undefined &&
    (garbageTruck
      ? isSequencePastStop(garbageTruck.heading_to_stop_sequence, targetSequence)
      : isSchedulePastGrace(
          candidate.hasTodayGarbage,
          candidate.minutesUntilScheduled
        ));

  const isRecyclePassed =
    candidate.recyclingEtaMinutes === undefined &&
    (recyclingTruck
      ? isSequencePastStop(
          recyclingTruck.heading_to_stop_sequence,
          targetSequence
        )
      : isSchedulePastGrace(
          candidate.hasTodayRecycling,
          candidate.minutesUntilScheduled
        ));

  const nextGarbageInfoSingle = getNextScheduledArrival(
    point.trashDay,
    candidate.scheduledTime,
    isGarbagePassed,
    [...DEFAULT_GARBAGE_DAYS]
  );
  // Area-wide: don't miss afternoon service on another nearby pin/route.
  const areaNextGarbage = pickEarliestNextArrival(
    candidates.slice(0, 15).map((c) => ({
      id: `${c.point.routeId}:${c.point.seq}`,
      name: c.point.pointName || c.point.address || "清運點",
      daysString: c.point.trashDay,
      scheduledTime: c.scheduledTime,
      hasPassedToday: isSchedulePastGrace(
        c.hasTodayGarbage,
        c.minutesUntilScheduled
      ),
      defaultDays: [...DEFAULT_GARBAGE_DAYS],
    }))
  );
  const nextGarbageInfo =
    areaNextGarbage &&
    (!nextGarbageInfoSingle ||
      areaNextGarbage.dateStr !== nextGarbageInfoSingle.dateStr)
      ? { dateStr: areaNextGarbage.dateStr, isToday: areaNextGarbage.isToday }
      : nextGarbageInfoSingle;
  const nextGarbageStopHint =
    areaNextGarbage &&
    areaNextGarbage.stopName &&
    areaNextGarbage.stopName !== stopName
      ? `（${areaNextGarbage.stopName}）`
      : "";
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
      ? `\n🚛 下次垃圾車：${nextGarbageInfo.dateStr}${nextGarbageStopHint}`
      : "";
    const nextRecycleText = nextRecycleInfo
      ? `\n♻️ 下次回收車：${nextRecycleInfo.dateStr}`
      : "";
    const historicalText = historicalReference
      ? `\n📊 歷史平均：約 ${historicalReference}`
      : "";
    const reasonText = isGarbagePassed || isRecyclePassed
      ? "目前判斷今日此站已過站或尚無可用即時訊號"
      : "今日此站無班次或尚無可用即時訊號";

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
      usedAlternateRoute,
      trashDays: point.trashDay,
      recycleDays: point.recycleDay,
      locateMode,
      radiusMeters,
      nearbyUncleared,
      message:
        `📍 最近清運點：${stopName}\n` +
        `🕐 官方表定：${formattedTime}${historicalText}\n` +
        `⚠️ ${reasonText}。${nextGarbageText}${nextRecycleText}`,
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

  const garbageSourceLabel =
    garbageEtaSource === "official"
      ? "官方即時"
      : garbageEtaSource === "estimated"
        ? "推估"
        : null;
  const recycleSourceLabel =
    recyclingEtaSource === "official"
      ? "官方即時"
      : recyclingEtaSource === "estimated"
        ? "推估"
        : null;

  const messageLines = [
    `📍 最近清運點：${stopName}`,
    usedAlternateRoute ? "🔄 已改追蹤附近有車的替代路線" : null,
    `🔎 模式：${locateMode === "recommend" ? "依時間推薦" : "整天班表"}｜半徑 ${radiusMeters}m`,
    nearbyUncleared.length > 1
      ? `🚩 附近待清運點：${nearbyUncleared.length} 處（地圖可看）`
      : null,
    `🕐 官方表定：${formattedTime}`,
    historicalReference ? `📊 歷史平均：約 ${historicalReference}` : null,
    garbageEtaMinutes !== undefined
      ? `🚛 垃圾車：約 ${garbageEtaMinutes} 分鐘（${garbageSourceLabel}）`
      : nextGarbageInfo && !nextGarbageInfo.isToday
        ? `🚛 下次垃圾車：${nextGarbageInfo.dateStr}`
        : nextGarbageInfo?.isToday
          ? `🚛 垃圾車：今日表定 ${formattedTime}，目前尚無即時訊號（常會延誤，請稍後再查）`
          : "⚠️ 垃圾車目前沒有可用的即時 ETA",
    recyclingEtaMinutes !== undefined
      ? `♻️ 回收車：約 ${recyclingEtaMinutes} 分鐘（${recycleSourceLabel}）`
      : nextRecycleInfo && !nextRecycleInfo.isToday
        ? `♻️ 下次回收車：${nextRecycleInfo.dateStr}`
        : nextRecycleInfo?.isToday
          ? `♻️ 回收車：今日表定 ${formattedTime}，目前尚無即時訊號`
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
    isStale,
    staleMinutes,
    garbageEtaSource,
    recyclingEtaSource,
    usedAlternateRoute,
    trashDays: point.trashDay,
    recycleDays: point.recycleDay,
    locateMode,
    radiusMeters,
    nearbyUncleared,
  };
}

async function getEtaErrorBiasMinutes(
  routeId: string,
  stopId: number
): Promise<number> {
  try {
    const db = getSupabaseClient();
    const thirtyDaysAgo = new Date(
      Date.now() - 30 * 24 * 60 * 60 * 1000
    ).toISOString();

    const { data, error } = await db
      .from("eta_logs")
      .select("estimated_eta_minutes, predicted_arrival_time, actual_arrival_time")
      .eq("route_id", routeId)
      .eq("stop_id", stopId)
      .not("actual_arrival_time", "is", null)
      .not("estimated_eta_minutes", "is", null)
      .gte("created_at", thirtyDaysAgo)
      .limit(50);

    if (error || !data || data.length === 0) return 0;

    let totalBias = 0;
    let count = 0;
    for (const log of data) {
      const estimated = Number(log.estimated_eta_minutes);
      if (!Number.isFinite(estimated) || !log.predicted_arrival_time || !log.actual_arrival_time) {
        continue;
      }
      const predicted = new Date(log.predicted_arrival_time).getTime();
      const actual = new Date(log.actual_arrival_time).getTime();
      if (Number.isNaN(predicted) || Number.isNaN(actual)) continue;

      // Positive bias => we usually arrive later than predicted (over-optimistic ETA).
      // Bias unit: estimated_minutes - actual_elapsed_minutes-from-query is hard without created_at;
      // use predicted vs actual clock difference in minutes instead.
      const bias = (predicted - actual) / 60_000;
      if (!Number.isFinite(bias)) continue;
      totalBias += bias;
      count++;
    }

    if (count < 3) return 0;
    return clampEtaBiasMinutes(totalBias / count);
  } catch (error) {
    console.error("[TruckService] Error calculating ETA bias:", error);
    return 0;
  }
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

export type RoutePathPoint = {
  lat: number;
  lng: number;
  seq?: number;
  name?: string;
  scheduledTime?: string | null;
};

/** Closest stop on a route to the user (from DB). */
async function findClosestDbStopOnRoute(
  routeId: string,
  userLat: number,
  userLng: number
): Promise<{
  lat: number;
  lng: number;
  seq: number;
  name: string;
  address?: string;
  scheduledTime: string | null;
  distanceMeters: number;
} | null> {
  const db = getSupabaseClient();
  const { data: stops } = await db
    .from("route_stops")
    .select("lat, lng, sequence_order, point_name, address, scheduled_time")
    .eq("route_id", routeId)
    .order("sequence_order", { ascending: true })
    .limit(400);

  if (!stops?.length) return null;

  let best: (typeof stops)[0] | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const s of stops) {
    if (typeof s.lat !== "number" || typeof s.lng !== "number") continue;
    if (!isValidCoordinate(s.lat, s.lng)) continue;
    const d = haversineDistance(userLat, userLng, s.lat, s.lng) * 1000;
    if (d < bestDist) {
      bestDist = d;
      best = s;
    }
  }
  if (!best) return null;

  const scheduled =
    typeof best.scheduled_time === "string"
      ? best.scheduled_time.slice(0, 5)
      : null;

  return {
    lat: best.lat,
    lng: best.lng,
    seq: best.sequence_order,
    name: best.point_name || best.address || `路線序 ${best.sequence_order}`,
    address: best.address ?? undefined,
    scheduledTime: scheduled,
    distanceMeters: Math.round(bestDist),
  };
}

export interface ClosestWaitPoint {
  lat: number;
  lng: number;
  seq: number;
  name: string;
  address?: string;
  scheduledTime?: string | null;
  distanceMeters: number;
  etaMinutes?: number;
  statusLabel: string;
}

/**
 * Full collection route for map + the point on that route closest to home (wait here).
 */
export async function getRoutePathForMap(
  routeId: string,
  options: { nearLat?: number; nearLng?: number; routeName?: string } = {}
): Promise<{
  routeId: string;
  routeName?: string;
  points: RoutePathPoint[];
  mode: "full" | "corridor" | "empty";
  closest?: ClosestWaitPoint;
}> {
  const redis = getRedis();
  const pointsCacheKey = `route_path_full_v2:${routeId}`;

  let routeName = options.routeName;
  let points: RoutePathPoint[] = [];

  try {
    const cached = await redis.get<RoutePathPoint[]>(pointsCacheKey);
    if (cached && cached.length >= 2) points = cached;
  } catch {
    /* ignore */
  }

  const db = getSupabaseClient();
  if (!routeName) {
    const { data: routeRow } = await db
      .from("truck_routes")
      .select("name")
      .eq("id", routeId)
      .maybeSingle();
    routeName = routeRow?.name ?? undefined;
  }

  if (points.length < 2) {
    const { data: stops } = await db
      .from("route_stops")
      .select("lat, lng, sequence_order, point_name, address, scheduled_time")
      .eq("route_id", routeId)
      .order("sequence_order", { ascending: true })
      .limit(400);

    if (stops && stops.length >= 2) {
      points = stops
        .filter(
          (s) =>
            typeof s.lat === "number" &&
            typeof s.lng === "number" &&
            isValidCoordinate(s.lat, s.lng)
        )
        .map((s) => ({
          lat: s.lat,
          lng: s.lng,
          seq: s.sequence_order,
          name: s.point_name || s.address || undefined,
          scheduledTime:
            typeof s.scheduled_time === "string"
              ? s.scheduled_time.slice(0, 5)
              : null,
        }));
    }
  }

  if (points.length < 2) {
    points = await fetchFullRoutePointsFromHccg(routeId);
    if (!routeName && points[0]?.name) {
      /* name on point is stop name, not route */
    }
  }

  if (points.length < 2) {
    // Last resort: local corridor from nearby API (incomplete but better than nothing)
    if (options.nearLat !== undefined && options.nearLng !== undefined) {
      try {
        const nearby = await fetchNearbyPointsCached(
          options.nearLat,
          options.nearLng,
          500,
          "all_day"
        );
        points = nearby
          .filter((p) => p.routeId === routeId)
          .map((p) => ({
            lat: parseFloat(p.lat),
            lng: parseFloat(p.lon),
            seq: parseInt(p.seq, 10) || 0,
            name: p.pointName || p.address,
            scheduledTime: parseScheduledTime(p.time),
          }))
          .filter((p) => isValidCoordinate(p.lat, p.lng))
          .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
        if (!routeName && nearby.find((p) => p.routeId === routeId)?.routeName) {
          routeName = nearby.find((p) => p.routeId === routeId)!.routeName;
        }
      } catch (err) {
        console.error("[TruckService] route fallback failed:", err);
      }
    }
  }

  if (points.length >= 2) {
    redis
      .set(pointsCacheKey, points, { ex: 60 * 60 * 24 })
      .catch(() => undefined);
  }

  let mode: "full" | "corridor" | "empty" =
    points.length >= 2 ? "full" : "empty";

  let closest: ClosestWaitPoint | undefined;
  if (
    points.length > 0 &&
    options.nearLat !== undefined &&
    options.nearLng !== undefined
  ) {
    closest = await buildClosestWaitPoint(
      routeId,
      points,
      options.nearLat,
      options.nearLng
    );
  }

  // Downsample for Leaflet; always keep closest point
  let drawPoints = points;
  if (points.length > 80) {
    const step = Math.ceil(points.length / 80);
    const keep = new Set<number>();
    points.forEach((_, i) => {
      if (i % step === 0 || i === points.length - 1) keep.add(i);
    });
    if (closest) {
      const idx = points.findIndex(
        (p) =>
          Math.abs(p.lat - closest!.lat) < 1e-6 &&
          Math.abs(p.lng - closest!.lng) < 1e-6
      );
      if (idx >= 0) keep.add(idx);
    }
    drawPoints = points.filter((_, i) => keep.has(i));
  }

  return {
    routeId,
    routeName,
    points: drawPoints,
    mode,
    closest,
  };
}

async function buildClosestWaitPoint(
  routeId: string,
  points: RoutePathPoint[],
  userLat: number,
  userLng: number
): Promise<ClosestWaitPoint> {
  let best = points[0];
  let bestDist = Number.POSITIVE_INFINITY;
  for (const p of points) {
    const d = haversineDistance(userLat, userLng, p.lat, p.lng) * 1000;
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }

  const seq = best.seq ?? 0;
  const name = best.name || `路線序 ${seq || "?"}`;
  let etaMinutes: number | undefined;
  let statusLabel = best.scheduledTime
    ? `表定 ${best.scheduledTime}`
    : "沿路線等候";

  try {
    const truckData = await loadLiveTrucksForRoute(routeId);
    const truck = truckData.garbage ?? truckData.recycling;
    if (truck && seq > 0) {
      if (isSequencePastStop(truck.heading_to_stop_sequence, seq)) {
        statusLabel = "此點可能已過，請看車頭方向沿線等";
      } else {
        etaMinutes = estimateEtaFromTruck(truck, best.lat, best.lng, seq);
        statusLabel = `預估約 ${etaMinutes} 分鐘抵達此處`;
      }
    } else if (best.scheduledTime) {
      const mins = getMinutesUntilScheduled(best.scheduledTime);
      if (mins !== null && mins >= -SCHEDULE_LATE_GRACE_MINUTES) {
        if (mins >= 0) {
          statusLabel = `表定約 ${mins} 分鐘後（${best.scheduledTime}）`;
        } else {
          statusLabel = `表定 ${best.scheduledTime}（可能延誤中）`;
        }
      }
    }
  } catch (err) {
    console.error("[TruckService] closest wait ETA failed:", err);
  }

  return {
    lat: best.lat,
    lng: best.lng,
    seq,
    name,
    scheduledTime: best.scheduledTime ?? null,
    distanceMeters: Math.round(bestDist),
    etaMinutes,
    statusLabel,
  };
}

/** Load all HCCG clean points for one route (cached). */
async function fetchFullRoutePointsFromHccg(
  routeId: string
): Promise<RoutePathPoint[]> {
  const redis = getRedis();
  const key = `hccg_route_points_v1:${routeId}`;
  try {
    const cached = await redis.get<RoutePathPoint[]>(key);
    if (cached && cached.length >= 2) return cached;
  } catch {
    /* ignore */
  }

  try {
    const params = new URLSearchParams({ address: "" });
    const response = await fetch(
      `${config.hccg.baseUrl}/getPointData?${params.toString()}`,
      {
        headers: {
          Referer: config.hccg.referer,
          "User-Agent": "EcoTrack-Bot/1.0",
        },
        signal: AbortSignal.timeout(12_000),
      }
    );
    if (!response.ok) return [];
    const json = (await response.json()) as HccgApiResponse<HccgCleanPointData>;
    if (json.statusCode !== 1 || !json.data?.cleanPoint) return [];

    const points = json.data.cleanPoint
      .filter((p) => p.routeId === routeId)
      .map((p) => ({
        lat: parseFloat(p.lat),
        lng: parseFloat(p.lon),
        seq: parseInt(p.seq, 10) || 0,
        name: p.pointName || p.address,
        scheduledTime: parseScheduledTime(p.time),
      }))
      .filter((p) => isValidCoordinate(p.lat, p.lng))
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

    if (points.length >= 2) {
      redis.set(key, points, { ex: 60 * 60 * 24 }).catch(() => undefined);
    }
    return points;
  } catch (err) {
    console.error("[TruckService] fetchFullRoutePointsFromHccg failed:", err);
    return [];
  }
}

