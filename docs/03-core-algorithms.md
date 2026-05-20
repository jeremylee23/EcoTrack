# 核心演算法與特殊邏輯處理

本文件紀錄了 EcoTrack 中為了解決實際運作時遇到的邊角案例 (Edge Cases) 所設計的特殊邏輯，這也是後續維護或導入 RAG 時，AI 需要理解的關鍵背景知識。

## 1. 路線切換偵測 (Route Switch Detection)

### 問題背景
當使用者已經設定過住家地址，並成功查詢過垃圾車後，系統會在 Redis 記錄該使用者目前正在追蹤的路線 (例如：`user_route:U1234...` = `181`)。
如果使用者搬家或想查另一個地方，傳送了新的 GPS 座標，系統原本只會更新資料庫的座標，但使用者下次查詢時，會疑惑為什麼一直查到「同一台車」或「錯誤的路線」。

### 解決方案
在 `api/webhook.ts` 的 `handleLocationMessage` 中加入「切換偵測邏輯」：
1. 收到新 GPS 時，計算出新的最近站點及其所屬路線 (`newStop.route_id`)。
2. 從 Redis 讀出使用者上次追蹤的路線 (`prevRoute.routeId`)。
3. 比對兩者。如果不一樣，就在回覆訊息中主動加上：
   > 🔄 路線已切換
   > 原路線：{舊路線}
   > 新路線：{新路線}
   > 現在將追蹤新地址最近的垃圾車 🚛
4. 將新的路線寫回 Redis，更新快取。

---

## 2. GPS 停滯與「今日無車」判斷 (GPS Staleness & Availability)

### 問題背景
HCCG API 回傳的車輛資料，如果該車輛今天沒有出勤（或是 GPS 機器沒開），API 可能會繼續回傳它**好幾天前**最後一次定位的狀態。
如果系統單純拿「現在時間」減去「API 回傳的更新時間」，會得出「GPS 已停滯 2880 分鐘」這種讓使用者恐慌或困惑的訊息。

### 解決方案
分為兩層處理：

#### A. 6 小時 Redis Fallback 門檻 (`STALE_THRESHOLD_MS`)
在 `truck.service.ts` 的 `calculateEta` 中，當即時 API 抓不到該路線有發車時，我們會嘗試從 Redis 拿最近一次的紀錄。
但我們加上了 6 小時的限制：
```typescript
const ageMs = now_fallback - new Date(redisFallback.updated_at).getTime();
if (ageMs < STALE_THRESHOLD_MS) truckData.garbage = redisFallback;
```
如果 Redis 裡的資料超過 6 小時，我們寧可當作「查無資料」，也不要拿舊資料誤導使用者。

#### B. UI 提示文字分級
在 `line.service.ts` 中，對於過舊的 GPS 資料給予不同的警告語氣：
- **< 2 小時**：紅色背景，提示「⚠️ GPS 已 X 分鐘未更新，預估時間可能不準確。」（代表車子可能在跑，但進了隧道或訊號死角）
- **> 2 小時**：黃色背景，提示「⚠️ GPS 訊號已超過 X 小時未更新（預估僅供參考） 💡 這不代表車輛閒置，昨日垃圾車仍可能正常出動，建議於表定時間前 30 分鐘再查。」（降低恐慌，並教育使用者政府 API 的特性）

---

## 3. 鄰近替代路線搜尋 (Alternative Route Fallback)

### 問題背景
有些地點可能處於兩條路線的交界。原本的邏輯是「嚴格找距離最近的站點」，然後只去查該站點的專屬路線。
如果該路線今天剛好沒車（或車子壞了沒開 GPS），系統就會直接回覆「找不到車」。但其實只要走幾步路，另一條路線的車可能正在附近收運。

### 解決方案
在 `truck.service.ts` 的 `calculateEta` 中加入 Fallback 邏輯：
1. `getNearestStop` 原本就會回傳半徑內的「多個」站點。
2. 優先查最近站點 (Primary Route)。
3. 如果 Primary Route 查無活動車輛，則開始**巡覽其餘站點**。
4. 設定條件：
   - 必須是不同的路線 ID。
   - 距離使用者必須在 **100 公尺以內** (`ALT_ROUTE_RADIUS_M = 100`)。
5. 只要 100m 內的其他路線有車，就**自動切換追蹤**那一條路線，並以該站點為基準計算 ETA。
