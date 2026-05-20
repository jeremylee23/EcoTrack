-- 1. 新增垃圾車與回收車的服務日期欄位
ALTER TABLE route_stops 
ADD COLUMN IF NOT EXISTS trash_day text,
ADD COLUMN IF NOT EXISTS recycle_day text;
