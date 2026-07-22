/**
 * User preferences + favorites (Redis).
 * Address is the stable identity; nickname/note is optional for family helpers.
 */

import { Redis } from "@upstash/redis";
import { config } from "../config/index.js";
import {
  shortenAddress,
  favoriteDisplayName,
  favoriteSubtitle,
} from "../utils/favorite-label.util.js";

export type LocateMode = "recommend" | "all_day";
export { shortenAddress, favoriteDisplayName, favoriteSubtitle };

export interface FavoriteSpot {
  id: string;
  /** Short address used as default button text */
  label: string;
  /** Optional friendly note, e.g. 兒子家 — never replaces address */
  nickname?: string;
  lat: number;
  lng: number;
  /** Full address from LINE location, if any */
  address?: string;
}

export interface UserPrefs {
  locateMode: LocateMode;
  radiusMeters: number;
  activeFavoriteId: string | null;
  favorites: FavoriteSpot[];
  /** Address from last 「定位」 send — shown so seniors aren't confused by abstract「住家」 */
  homeAddress?: string;
}

type PendingAction =
  | { type: "add" }
  | { type: "nickname"; favoriteId: string };

const PREFS_KEY = (userId: string) => `user_prefs:${userId}`;
const PENDING_KEY = (userId: string) => `fav_pending:${userId}`;
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
    favorites: Array.isArray(parsed.favorites)
      ? parsed.favorites.slice(0, 3).map((f) => ({
          ...f,
          nickname: f.nickname?.trim() || undefined,
        }))
      : [],
    homeAddress: parsed.homeAddress?.trim() || undefined,
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
    homeAddress:
      patch.homeAddress !== undefined
        ? patch.homeAddress?.trim() || undefined
        : current.homeAddress,
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
  // Match by id, else by same coordinates (~11m), else by label
  const existing =
    (spot.id && prefs.favorites.find((f) => f.id === spot.id)) ||
    prefs.favorites.find(
      (f) =>
        Math.abs(f.lat - spot.lat) < 0.0001 &&
        Math.abs(f.lng - spot.lng) < 0.0001
    ) ||
    prefs.favorites.find((f) => f.label === spot.label && !spot.nickname);

  const id = spot.id ?? existing?.id ?? `fav_${Date.now()}`;
  const nextSpot: FavoriteSpot = {
    id,
    label: spot.label.slice(0, 20),
    nickname: spot.nickname?.trim() || existing?.nickname,
    lat: spot.lat,
    lng: spot.lng,
    address: spot.address ?? existing?.address,
  };

  const others = prefs.favorites.filter((f) => f.id !== id);
  const favorites = [nextSpot, ...others].slice(0, 3);
  return setUserPrefs(userId, {
    favorites,
    activeFavoriteId: id,
  });
}

export async function setFavoriteNickname(
  userId: string,
  favoriteId: string,
  nickname: string
): Promise<UserPrefs | null> {
  const prefs = await getUserPrefs(userId);
  const clean = nickname.trim().slice(0, 12);
  if (!clean) return null;

  let found = false;
  const favorites = prefs.favorites.map((f) => {
    if (f.id !== favoriteId) return f;
    found = true;
    return { ...f, nickname: clean };
  });
  if (!found) return null;
  return setUserPrefs(userId, { favorites });
}

export async function removeFavoriteById(
  userId: string,
  favoriteId: string
): Promise<UserPrefs> {
  const prefs = await getUserPrefs(userId);
  const favorites = prefs.favorites.filter((f) => f.id !== favoriteId);
  const activeFavoriteId =
    prefs.activeFavoriteId === favoriteId ? null : prefs.activeFavoriteId;
  return setUserPrefs(userId, { favorites, activeFavoriteId });
}

/** @deprecated prefer removeFavoriteById */
export async function removeFavoriteByLabel(
  userId: string,
  label: string
): Promise<UserPrefs> {
  const prefs = await getUserPrefs(userId);
  const target = prefs.favorites.find(
    (f) => f.label === label || f.nickname === label || favoriteDisplayName(f) === label
  );
  if (!target) return prefs;
  return removeFavoriteById(userId, target.id);
}

export async function clearActiveFavorite(userId: string): Promise<UserPrefs> {
  return setUserPrefs(userId, { activeFavoriteId: null });
}

export async function setPendingAddFavorite(userId: string): Promise<void> {
  const redis = getRedis();
  const payload: PendingAction = { type: "add" };
  await redis.set(PENDING_KEY(userId), JSON.stringify(payload), { ex: 60 * 30 });
}

export async function setPendingNickname(
  userId: string,
  favoriteId: string
): Promise<void> {
  const redis = getRedis();
  const payload: PendingAction = { type: "nickname", favoriteId };
  await redis.set(PENDING_KEY(userId), JSON.stringify(payload), { ex: 60 * 30 });
}

export async function peekPendingAction(
  userId: string
): Promise<PendingAction | null> {
  const redis = getRedis();
  const raw = await redis.get<string | PendingAction>(PENDING_KEY(userId));
  if (!raw) return null;
  const parsed =
    typeof raw === "string" ? (JSON.parse(raw) as PendingAction) : raw;
  if (parsed?.type === "add") return parsed;
  if (parsed?.type === "nickname" && parsed.favoriteId) return parsed;
  return null;
}

export async function consumePendingAction(
  userId: string
): Promise<PendingAction | null> {
  const pending = await peekPendingAction(userId);
  if (!pending) return null;
  const redis = getRedis();
  await redis.del(PENDING_KEY(userId));
  return pending;
}

export async function clearPendingAction(userId: string): Promise<void> {
  const redis = getRedis();
  await redis.del(PENDING_KEY(userId));
}
