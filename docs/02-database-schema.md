# 資料庫 Schema 說明

## Supabase 專案設定

- 擴充功能：`pgvector`（目前未啟用）、`postgis`（已啟用，必要）
- 時區：UTC，程式碼內部轉換為 UTC+8

---

## 資料表結構

### `users` — 使用者資料

| 欄位 | 型別 | 說明 |
|------|------|------|
| `id` | uuid | 主鍵 |
| `line_user_id` | text UNIQUE | LINE userId |
| `home_location` | geometry(Point, 4326) | PostGIS 點座標（住家位置）|
| `home_lat` | float8 | 緯度（反正規化，加速讀取）|
| `home_lng` | float8 | 經度（反正規化）|
| `created_at` | timestamptz | 建立時間 |
| `updated_at` | timestamptz | 最後更新 |

---

### `route_stops` — 垃圾車停靠站點

| 欄位 | 型別 | 說明 |
|------|------|------|
| `id` | uuid | 主鍵 |
| `route_id` | text | HCCG 路線 ID（如 `"181"`）|
| `route_name` | text | 路線名稱 |
| `sequence_order` | int | 停靠順序（對應 `seq`）|
| `location` | geometry(Point, 4326) | 站點座標（PostGIS）|
| `lat` | float8 | 緯度 |
| `lng` | float8 | 經度 |
| `point_name` | text | 站點名稱 |
| `address` | text | 站點地址 |
| `scheduled_time` | text | 表定時間（`"HH:MM"` 格式）|
| `district` | text | 行政區（`"3"` = 香山）|
| `trash_day` | text | 收垃圾星期（`"1,2,4,5,6"`）|
| `recycle_day` | text | 回收星期 |

> 目前 seed 資料：香山區 **13 條路線 × 424 個站點**

---

### `eta_logs` — ETA 預估歷史日誌

| 欄位 | 型別 | 說明 |
|------|------|------|
| `id` | uuid | 主鍵 |
| `route_id` | text | 路線 ID |
| `stop_id` | int | 站點序號 |
| `car_no` | text | 車牌號碼 |
| `car_type` | text | `"0"` 垃圾 / `"1"` 回收 |
| `user_lat` | float8 | 查詢時用戶位置 |
| `user_lng` | float8 | 查詢時用戶位置 |
| `estimated_eta_minutes` | int | 預估分鐘數 |
| `predicted_arrival_time` | timestamptz | 預估到達時間 |
| `actual_arrival_time` | timestamptz | 實際到達時間（cron 回寫）|
| `created_at` | timestamptz | 查詢時間 |

**用途**：累積後用來計算歷史平均到達時間（顯示在 Flex Message 卡片上）。

---

## Supabase RPC 函數

### `upsert_user_location(p_line_user_id, p_lat, p_lng)`

```sql
-- 建立或更新用戶住家座標
-- 使用 PostGIS ST_MakePoint 處理 geometry 型別
INSERT INTO users (line_user_id, home_location, home_lat, home_lng)
VALUES (p_line_user_id, ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326), p_lat, p_lng)
ON CONFLICT (line_user_id) DO UPDATE SET ...
```

### `get_user_coords(p_line_user_id)`

```sql
-- 回傳 { lat, lng }
SELECT home_lat as lat, home_lng as lng FROM users WHERE line_user_id = p_line_user_id
```

### `find_nearest_stop(p_lat, p_lng, p_radius_meters)`

```sql
-- 使用 PostGIS ST_DWithin 找半徑內的站點
-- 回傳最多 20 個站點，按距離排序
SELECT *, ST_Distance(...) as distance_meters
FROM route_stops
WHERE ST_DWithin(location::geography, ST_MakePoint(p_lng, p_lat)::geography, p_radius_meters)
ORDER BY distance_meters
LIMIT 20
```

**預設搜尋半徑**：`1500` 公尺（config 中 `nearestStopRadiusMeters`）

---

## Redis (Upstash) 資料結構

### 車輛即時 GPS

```
Key:   truck_live:{routeId}:{carType}
       例：truck_live:181:0  (垃圾車)
           truck_live:181:1  (回收車)

Value: TruckLiveData JSON
  {
    lat, lng, speed,
    updated_at,              // ISO 8601
    heading_to_stop_sequence,
    car_no, route_name, status, direction, car_type
  }

TTL:   300 秒（5 分鐘）
```

### 使用者追蹤路線

```
Key:   user_route:{lineUserId}
       例：user_route:U1a2b3c4d5e6f...

Value: JSON string
  { "routeId": "181", "routeName": "181" }

TTL:   604800 秒（7 天）
```
