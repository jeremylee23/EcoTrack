-- ============================================================
-- 001_init.sql — EcoTrack Core Schema
-- Hsinchu Garbage Truck Tracker (香山區 MVP)
-- Run this in your Supabase SQL Editor
-- ============================================================

-- Enable PostGIS extension (required for spatial queries)
CREATE EXTENSION IF NOT EXISTS postgis;

-- ── Table: users ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.users (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  line_user_id     VARCHAR(64)  NOT NULL,
  home_location    GEOMETRY(Point, 4326) NULL,
  home_lat         DOUBLE PRECISION NULL,  -- denormalized for fast reads
  home_lng         DOUBLE PRECISION NULL,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_line_user_id ON public.users (line_user_id);
CREATE INDEX IF NOT EXISTS idx_users_home_location ON public.users USING GIST (home_location);

-- ── Table: truck_routes ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.truck_routes (
  id               VARCHAR(32)  PRIMARY KEY,   -- e.g. "181", "183" (HCCG routeId)
  name             VARCHAR(128) NOT NULL,
  type             VARCHAR(16)  NOT NULL CHECK (type IN ('general', 'recycle')),
  car_no           VARCHAR(16)  NULL,
  trash_day        VARCHAR(32)  NULL,           -- "1,2,4,5,6" weekday codes
  recycle_day      VARCHAR(32)  NULL
);

-- ── Table: route_stops ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.route_stops (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id         VARCHAR(32)  NOT NULL REFERENCES public.truck_routes(id) ON DELETE CASCADE,
  sequence_order   INTEGER      NOT NULL,
  location         GEOMETRY(Point, 4326) NOT NULL,
  lat              DOUBLE PRECISION NOT NULL,
  lng              DOUBLE PRECISION NOT NULL,
  scheduled_time   TIME         NULL,
  point_name       VARCHAR(128) NULL,
  address          VARCHAR(256) NULL
);

CREATE INDEX IF NOT EXISTS idx_route_stops_location ON public.route_stops USING GIST (location);
CREATE INDEX IF NOT EXISTS idx_route_stops_route_id ON public.route_stops (route_id);

-- ── RPC: upsert_user_location ────────────────────────────────
-- Called by user.service.ts to safely insert/update user GPS
CREATE OR REPLACE FUNCTION public.upsert_user_location(
  p_line_user_id VARCHAR,
  p_lat          DOUBLE PRECISION,
  p_lng          DOUBLE PRECISION
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_result JSONB;
BEGIN
  INSERT INTO public.users (line_user_id, home_location, home_lat, home_lng, updated_at)
  VALUES (
    p_line_user_id,
    ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326),
    p_lat,
    p_lng,
    NOW()
  )
  ON CONFLICT (line_user_id) DO UPDATE SET
    home_location = ST_SetSRID(ST_MakePoint(EXCLUDED.home_lng, EXCLUDED.home_lat), 4326),
    home_lat      = EXCLUDED.home_lat,
    home_lng      = EXCLUDED.home_lng,
    updated_at    = NOW()
  RETURNING jsonb_build_object(
    'id',           id::text,
    'line_user_id', line_user_id,
    'home_lat',     home_lat,
    'home_lng',     home_lng,
    'updated_at',   updated_at
  ) INTO v_result;

  RETURN v_result;
END;
$$;

-- ── RPC: get_user_coords ─────────────────────────────────────
-- Returns lat/lng for a given LINE user
CREATE OR REPLACE FUNCTION public.get_user_coords(
  p_line_user_id VARCHAR
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_result JSONB;
BEGIN
  SELECT jsonb_build_object(
    'lat', home_lat,
    'lng', home_lng
  )
  INTO v_result
  FROM public.users
  WHERE line_user_id = p_line_user_id;

  RETURN v_result;
END;
$$;

-- ── RPC: find_nearest_stop ───────────────────────────────────
-- Finds the nearest route_stop to a given coordinate within a radius.
-- Uses ST_DWithin (index-accelerated) first, then orders by ST_Distance.
CREATE OR REPLACE FUNCTION public.find_nearest_stop(
  p_lat            DOUBLE PRECISION,
  p_lng            DOUBLE PRECISION,
  p_radius_meters  INTEGER DEFAULT 1500
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_point GEOMETRY;
  v_result     JSONB;
BEGIN
  v_user_point := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326);

  SELECT jsonb_build_object(
    'id',             rs.id::text,
    'route_id',       rs.route_id,
    'sequence_order', rs.sequence_order,
    'scheduled_time', rs.scheduled_time::text,
    'point_name',     rs.point_name,
    'address',        rs.address,
    'lat',            rs.lat,
    'lng',            rs.lng,
    'distance_meters', ST_Distance(rs.location::geography, v_user_point::geography)
  )
  INTO v_result
  FROM public.route_stops rs
  JOIN public.truck_routes tr ON tr.id = rs.route_id
  WHERE ST_DWithin(
    rs.location::geography,
    v_user_point::geography,
    p_radius_meters
  )
  ORDER BY rs.location::geography <-> v_user_point::geography
  LIMIT 1;

  RETURN v_result;
END;
$$;

-- Grant execute permissions to the anon and service_role keys
GRANT EXECUTE ON FUNCTION public.upsert_user_location TO anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_user_coords TO anon, service_role;
GRANT EXECUTE ON FUNCTION public.find_nearest_stop TO anon, service_role;

-- Grant table access
GRANT SELECT, INSERT, UPDATE ON public.users TO service_role;
GRANT SELECT ON public.truck_routes TO service_role;
GRANT SELECT ON public.route_stops TO service_role;
