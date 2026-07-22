/**
 * User query preferences + named favorites (Redis-backed, fast).
 * Designed for one-tap elderly UX — presets, no typing required.
 */

import { Redis } from "@upstash/redis";
import { config } from "../config/index.js";

export type LocateMode = "recommend" | "all_day";

/** Preset labels seniors can tap — no free typing. */
export const FAVORITE_PRESETS = ["兒女家", "醫院", "公園", "市場"] as const;
export type FavoritePreset = (typeof FAVORITE_PRESETS)[number];

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
const PENDING_FAV_KEY = (userId: string) => `fav_pending:${userId}`;
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

export function isFavoritePreset(label: string): label is FavoritePreset {
  return (FAVORITE_PRESETS as readonly string[]).includes(label);
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
  const existing = prefs.favorites.find((f) => f.label === spot.label);
  const id = spot.id ?? existing?.id ?? `fav_${Date.now()}`;
  const nextSpot: FavoriteSpot = {
    id,
    label: spot.label.slice(0, 20),
    lat: spot.lat,
    lng: spot.lng,
    address: spot.address,
  };

  const others = prefs.favorites.filter(
    (f) => f.id !== id && f.label !== nextSpot.label
  );
  const favorites = [nextSpot, ...others].slice(0, 3);
  return setUserPrefs(userId, {
    favorites,
    activeFavoriteId: id,
  });
}

export async function removeFavoriteByLabel(
  userId: string,
  label: string
): Promise<UserPrefs> {
  const prefs = await getUserPrefs(userId);
  const favorites = prefs.favorites.filter((f) => f.label !== label);
  const removed = prefs.favorites.find((f) => f.label === label);
  const activeFavoriteId =
    removed && prefs.activeFavoriteId === removed.id
      ? null
      : prefs.activeFavoriteId;
  return setUserPrefs(userId, { favorites, activeFavoriteId });
}

export async function clearActiveFavorite(userId: string): Promise<UserPrefs> {
  return setUserPrefs(userId, { activeFavoriteId: null });
}

/** Remember which preset the senior wants to save next (TTL 30 min). */
export async function setPendingFavoriteLabel(
  userId: string,
  label: FavoritePreset
): Promise<void> {
  const redis = getRedis();
  await redis.set(PENDING_FAV_KEY(userId), label, { ex: 60 * 30 });
}

export async function peekPendingFavoriteLabel(
  userId: string
): Promise<FavoritePreset | null> {
  const redis = getRedis();
  const raw = await redis.get<string>(PENDING_FAV_KEY(userId));
  if (!raw || !isFavoritePreset(raw)) return null;
  return raw;
}

export async function consumePendingFavoriteLabel(
  userId: string
): Promise<FavoritePreset | null> {
  const label = await peekPendingFavoriteLabel(userId);
  if (!label) return null;
  const redis = getRedis();
  await redis.del(PENDING_FAV_KEY(userId));
  return label;
}

export async function clearPendingFavoriteLabel(userId: string): Promise<void> {
  const redis = getRedis();
  await redis.del(PENDING_FAV_KEY(userId));
}
