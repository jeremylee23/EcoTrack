-- ============================================================
-- 004_notify.sql — Approaching-truck push notification opt-in
-- ============================================================

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS notify_enabled BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN public.users.notify_enabled IS
  'When true, EcoTrack may push a LINE reminder when a garbage truck is ~5 minutes away.';
