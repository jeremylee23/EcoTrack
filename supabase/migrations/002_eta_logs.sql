-- ============================================================
-- 002_eta_logs.sql — ETA Data Collection
-- Stores estimated vs actual arrival times for ML training
-- ============================================================

CREATE TABLE IF NOT EXISTS public.eta_logs (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id                VARCHAR(32) NOT NULL,
  stop_id                 INT NOT NULL, -- sequence_order of the stop
  car_no                  VARCHAR(32),
  user_lat                DOUBLE PRECISION,
  user_lng                DOUBLE PRECISION,
  estimated_eta_minutes   INT NOT NULL,
  predicted_arrival_time  TIMESTAMPTZ NOT NULL,
  actual_arrival_time     TIMESTAMPTZ NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for cron job to quickly find pending logs for a route
CREATE INDEX IF NOT EXISTS idx_eta_logs_pending ON public.eta_logs (route_id, actual_arrival_time) WHERE actual_arrival_time IS NULL;

-- Permissions
GRANT SELECT, INSERT, UPDATE ON public.eta_logs TO service_role;
