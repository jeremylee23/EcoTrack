/**
 * User query preferences + named favorites (Redis-backed, fast).
 * Beats the official site by persisting settings in chat without opening a web UI.
 */

import { Redis } from "@upstash/redis";
import { config } from "../config/index.js";

export type LocateMode = "recommend" | "all_day";

export interface FavoriteSpot {
  id: string;
  label: string;
  lat: number;
  lng: number;
  address?: string;
}

export interface UserPrefs {
  locateMode: LocateMode;
  /** Search radius in meters (50–500). Official default is 100. */
  radiusMeters: number;
  /** Active favorite id; null = primary home location */
  activeFavoriteId: string | null;
  favorites: FavoriteSpot[];
}

const PREFS_KEY = (userId: string) => `user_prefs:${userId}`;
const DEFAULT_PREFS: UserPrefs = {
  locateMode: "recommend",
  radiusMeters: 100,
  activeFavoriteId: null,
  favorites: [],
};

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

export function clampRadiusMeters(value: number): number {
  if (!Number.isFinite(value)) return 100;
  return Math.max(50, Math.min(500, Math.round(value)));
}

export async function getUserPrefs(userId: string): Promise<UserPrefs> {
  const redis = getRedis();
  const raw = await redis.get<UserPrefs | string>(PREFS_KEY(userId));
  if (!raw) return { ...DEFAULT_PREFS, favorites: [] };

  const parsed = typeof raw === "string" ? (JSON.parse(raw) as UserPrefs) : raw;
  return {
    locateMode: parsed.locateMode === "all_day" ? "all_day" : "recommend",
    radiusMeters: clampRadiusMeters(parsed.radiusMeters ?? 100),
    activeFavoriteId: parsed.activeFavoriteId ?? null,
    favorites: Array.isArray(parsed.favorites) ? parsed.favorites.slice(0, 3) : [],
  };
}

export async function setUserPrefs(
  userId: string,
  patch: Partial<UserPrefs>
): Promise<UserPrefs> {
  const current = await getUserPrefs(userId);
  const next: UserPrefs = {
    ...current,
    ...patch,
    radiusMeters: clampRadiusMeters(
      patch.radiusMeters ?? current.radiusMeters
    ),
    favorites: (patch.favorites ?? current.favorites).slice(0, 3),
  };
  const redis = getRedis();
  await redis.set(PREFS_KEY(userId), JSON.stringify(next), {
    ex: 60 * 60 * 24 * 90,
  });
  return next;
}

export async function upsertFavorite(
  userId: string,
  spot: Omit<FavoriteSpot, "id"> & { id?: string }
): Promise<UserPrefs> {
  const prefs = await getUserPrefs(userId);
  const id = spot.id ?? `fav_${Date.now()}`;
  const nextSpot: FavoriteSpot = {
    id,
    label: spot.label.slice(0, 20),
    lat: spot.lat,
    lng: spot.lng,
    address: spot.address,
  };

  const others = prefs.favorites.filter((f) => f.id !== id && f.label !== nextSpot.label);
  const favorites = [nextSpot, ...others].slice(0, 3);
  return setUserPrefs(userId, {
    favorites,
    activeFavoriteId: id,
  });
}

export async function clearActiveFavorite(userId: string): Promise<UserPrefs> {
  return setUserPrefs(userId, { activeFavoriteId: null });
}
