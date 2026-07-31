-- Persist truck GPS samples so ETA can learn from real route movement.

CREATE TABLE IF NOT EXISTS public.truck_gps_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id        VARCHAR(32) NOT NULL,
  car_type        VARCHAR(10) NOT NULL,
  car_no          VARCHAR(32),
  stop_sequence   INT,
  lat             DOUBLE PRECISION NOT NULL,
  lng             DOUBLE PRECISION NOT NULL,
  speed_kmh       DOUBLE PRECISION,
  observed_at     TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_truck_gps_logs_unique_sample
  ON public.truck_gps_logs (route_id, car_type, observed_at);

CREATE INDEX IF NOT EXISTS idx_truck_gps_logs_recent
  ON public.truck_gps_logs (route_id, car_type, observed_at DESC);

GRANT SELECT, INSERT ON public.truck_gps_logs TO service_role;