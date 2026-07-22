/**
 * services/user.service.ts
 * Handles all PostgreSQL (Supabase) operations for the `users` table.
 * Uses PostGIS spatial functions for nearest-stop queries.
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { config } from "../config/index.js";
import type { User, NearestStopResult } from "../types/index.js";

// ── Singleton Supabase client ────────────────────────────────

let _client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (!_client) {
    _client = createClient(
      config.supabase.url,
      config.supabase.serviceRoleKey,
      { auth: { persistSession: false } }
    );
  }
  return _client;
}

// ── Public API ───────────────────────────────────────────────

/**
 * Creates or updates a user's home location via PostGIS RPC.
 * Delegates ST_MakePoint / ST_SetSRID geometry construction to PostgreSQL.
 */
export async function upsertUserLocation(
  lineUserId: string,
  lat: number,
  lng: number
): Promise<User> {
  const db = getSupabaseClient();

  const { data, error } = await db.rpc("upsert_user_location", {
    p_line_user_id: lineUserId,
    p_lat: lat,
    p_lng: lng,
  });

  if (error) {
    throw new Error(`[UserService] upsertUserLocation failed: ${error.message}`);
  }

  return data as User;
}

/**
 * Retrieves a user record by LINE User ID.
 * Returns null if the user hasn't registered yet.
 */
export async function getUserByLineId(lineUserId: string): Promise<User | null> {
  const db = getSupabaseClient();

  const { data, error } = await db
    .from("users")
    .select("*")
    .eq("line_user_id", lineUserId)
    .maybeSingle();

  if (error) {
    throw new Error(`[UserService] getUserByLineId failed: ${error.message}`);
  }

  return data as User | null;
}

/**
 * Finds the nearest route stop to a given coordinate using PostGIS.
 * Delegates ST_DWithin + ST_Distance to PostgreSQL — no JS geo math needed.
 *
 * Uses RPC function `find_nearest_stop(p_lat, p_lng, p_radius_meters)`.
 */
export async function getNearestStop(
  lat: number,
  lng: number,
  radiusMeters?: number
): Promise<NearestStopResult[]> {
  const db = getSupabaseClient();
  const radius = radiusMeters ?? config.hsinchu.nearestStopRadiusMeters;

  const { data, error } = await db.rpc("find_nearest_stop", {
    p_lat: lat,
    p_lng: lng,
    p_radius_meters: radius,
  });

  if (error) {
    throw new Error(`[UserService] getNearestStop failed: ${error.message}`);
  }

  if (!data || !Array.isArray(data) || data.length === 0) {
    return [];
  }

  // Workaround: The RPC find_nearest_stop might have a fixed RETURNS TABLE schema that omits trash_day/recycle_day.
  // We fetch them manually here and merge them.
  const stops = data as NearestStopResult[];
  const stopIds = stops.map(s => s.id);
  const { data: extraData } = await db.from("route_stops").select("id, trash_day, recycle_day").in("id", stopIds);

  if (extraData) {
    const extraMap = new Map(extraData.map(e => [e.id, e]));
    for (const stop of stops) {
      const extra = extraMap.get(stop.id);
      if (extra) {
        stop.trash_day = extra.trash_day;
        stop.recycle_day = extra.recycle_day;
      }
    }
  }

  return stops;
}

/**
 * Users eligible for approaching-truck push reminders.
 */
export async function listUsersForNotify(limit = 80): Promise<
  Array<{ line_user_id: string; home_lat: number; home_lng: number }>
> {
  const db = getSupabaseClient();

  const mapRows = (
    data: Array<{
      line_user_id: string;
      home_lat: number | null;
      home_lng: number | null;
    }> | null
  ) =>
    (data ?? [])
      .filter(
        (row): row is { line_user_id: string; home_lat: number; home_lng: number } =>
          typeof row.line_user_id === "string" &&
          typeof row.home_lat === "number" &&
          typeof row.home_lng === "number"
      )
      .map(({ line_user_id, home_lat, home_lng }) => ({
        line_user_id,
        home_lat,
        home_lng,
      }));

  const primary = await db
    .from("users")
    .select("line_user_id, home_lat, home_lng, notify_enabled")
    .eq("notify_enabled", true)
    .not("home_lat", "is", null)
    .not("home_lng", "is", null)
    .limit(limit);

  if (!primary.error) {
    return mapRows(primary.data);
  }

  // Migration 004 may not be applied yet — fall back without the column filter.
  console.warn(
    "[UserService] notify_enabled unavailable, falling back:",
    primary.error.message
  );
  const fallback = await db
    .from("users")
    .select("line_user_id, home_lat, home_lng")
    .not("home_lat", "is", null)
    .not("home_lng", "is", null)
    .limit(limit);

  if (fallback.error) {
    throw new Error(
      `[UserService] listUsersForNotify failed: ${fallback.error.message}`
    );
  }

  return mapRows(fallback.data);
}
