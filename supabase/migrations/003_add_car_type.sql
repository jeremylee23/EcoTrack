-- Add car_type to eta_logs to differentiate between garbage ('0') and recycling ('1') trucks
ALTER TABLE public.eta_logs 
ADD COLUMN car_type VARCHAR(10) NOT NULL DEFAULT '0';

-- Drop the old unique constraint if it exists and recreate it to include car_type
ALTER TABLE public.eta_logs DROP CONSTRAINT IF EXISTS eta_logs_route_id_stop_id_key;

-- We shouldn't enforce unique constraints strictly since the truck might visit the same stop on different days.
-- The previous schema didn't have a unique constraint, so we just add an index.
CREATE INDEX IF NOT EXISTS idx_eta_logs_car_type ON public.eta_logs (car_type);
