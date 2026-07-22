# 核心演算法與特殊邏輯處理

本文件紀錄了 EcoTrack 中為了解決實際運作時遇到的邊角案例 (Edge Cases) 所設計的特殊邏輯，這也是後續維護或導入 RAG 時，AI 需要理解的關鍵背景知識。

## 1. 路線切換偵測 (Route Switch Detection)

### 問題背景
當使用者已經設定過住家地址，並成功查詢過垃圾車後，系統會在 Redis 記錄該使用者目前正在追蹤的路線 (例如：`user_route:U1234...` = `181`)。
如果使用者搬家或想查另一個地方，傳送了新的 GPS 座標，系統原本只會更新資料庫的座標，但使用者下次查詢時，會疑惑為什麼一直查到「同一台車」或「錯誤的路線」。

### 解決方案
在 `api/webhook.ts` 的 `handleLocationMessage` 中加入「切換偵測邏輯」：
1. 收到新 GPS 時，用官方鄰近點 API 算出新路線 (`resolveNearestRoute`)。
2. 從 Redis 讀出使用者上次追蹤的路線 (`prevRoute.routeId`)。
3. 比對兩者。如果不一樣，就在回覆訊息中主動加上路線切換提示。
4. 將新的路線寫回 Redis，更新快取。

---

## 2. GPS 停滯與「今日無車」判斷 (GPS Staleness & Availability)

### 問題背景
HCCG API 回傳的車輛資料，如果該車輛今天沒有出勤（或是 GPS 機器沒開），API 可能會繼續回傳它**好幾天前**最後一次定位的狀態，且 `seq` 常為 `-1`。
如果系統單純拿這些死掉的座標去算距離 ETA，會得出「還有 X 分鐘」這種看起來很準、其實完全錯的結果。

### 解決方案
分為三層處理：

#### A. 可用性消毒 (`sanitizeLiveTruck`)
無論資料來自即時 API 或 Redis fallback，都必須通過：
1. GPS 年齡 < **6 小時**（`STALE_THRESHOLD_MS`）
2. `heading_to_stop_sequence >= 0`（拒絕官方常回的 `seq=-1` 收班殘留）
3. `carStatus !== "1"`（已完成路線不計入即時 ETA）

#### B. 6 小時 Redis Fallback 門檻
Redis fallback 也走同一套 `sanitizeLiveTruck`。

#### C. UI 提示文字分級
GPS 偏舊（>15 分鐘）時在 Flex 顯示警告。

---

## 3. 「已過站 / 今日無班次」誤判防護 (Late Grace)

1. **過站寬限** `SCHEDULE_LATE_GRACE_MINUTES = 120`
2. **硬證據優先**：有即時 GPS 且 `seq > 目標站` 才算過站；有官方 `estimate >= 0` 時絕不判過站
3. **今日仍可能來車**：寬限內顯示「表定 + 等待訊號」
4. **空的 trashDay**：預設 `[1,2,4,5,6]`

---

## 4. 鄰近替代路線搜尋 (Alternative Route Fallback)

當主清運點所屬路線沒有官方即時 ETA、也沒有可用 GPS 時：
1. 巡覽鄰近候選站點
2. 條件：不同 `routeId`，距離使用者 ≤ **100m**
3. 只要該路線有即時訊號，就自動切換追蹤並標記 `usedAlternateRoute`

---

## 5. ETA 來源與歷史校正

- **官方即時**：`getPointData.estimate >= 0` 且 `status=1`
- **距離推估**：由車輛 GPS + 均速推算，並用 `eta_logs` 的預測/實際誤差做小幅 bias 校正（±15 分鐘內）
- UI 會標示來源（官方即時 / 距離推估）

---

## 6. Webhook 錯誤回覆

任何 handler 例外都應盡力用 `replyToken` 回覆「系統暫時無法完成查詢」，避免 LINE 端看起來完全無反應。

---

## 7. 靠近提醒（Approaching Notify）

`/api/cron/notify-approaching`（GitHub Actions 每 10 分鐘）：
- 找出 `notify_enabled=true` 且有住家座標的使用者
- `calculateEta` 若垃圾車 ETA ≤ 5 分鐘 → LINE Push
- Redis key `notify_sent:{userId}:{routeId}:{YYYY-MM-DD}` 去重
