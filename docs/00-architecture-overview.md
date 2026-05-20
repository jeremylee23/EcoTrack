# EcoTrack 新竹市垃圾車追蹤 LINE Bot — 架構總覽

## 專案目標

讓新竹市居民透過 LINE 傳送 GPS 定位，即時查詢附近垃圾車的預估到達時間（ETA）。

## 技術架構圖

```
用戶 LINE App
      │ 傳送 GPS 位置 / 文字查詢
      ▼
LINE Messaging API
      │ Webhook POST
      ▼
Vercel Serverless Function
  /api/webhook.ts
      │
      ├── 位置訊息 → upsertUserLocation() → Supabase (users table)
      │
      └── 查詢 ETA  → calculateEta()
                          │
                          ├── getNearestStop()  → Supabase PostGIS RPC
                          ├── syncSingleTruck() → HCCG API (7966.hccg.gov.tw)
                          └── getTruckLiveData() → Upstash Redis (fallback)

Vercel Cron Job (每 5 分鐘)
  /api/cron/sync-trucks.ts
      │ 全區掃描
      ▼
  HCCG API → Upstash Redis (批次更新所有路線)
```

## 雲端服務清單

| 服務 | 用途 | 費用層級 |
|------|------|----------|
| **Vercel** | Serverless Function 運行 + Cron Job 排程 | Free (Hobby) |
| **Supabase** | PostgreSQL + PostGIS 空間資料庫 | Free tier |
| **Upstash Redis** | 即時 GPS 快取（TTL 300s） | Free tier |
| **LINE Messaging API** | 聊天機器人介面 | Free (Messaging API) |
| **HCCG API** | 新竹市政府即時垃圾車資料 | 免費公開（無需 Key） |

## 核心資料流

### 1. 用戶設定位置

```
用戶傳送 GPS → handleLocationMessage()
  → upsertUserLocation(lineUserId, lat, lng) [Supabase RPC]
  → getNearestStop(lat, lng) [PostGIS 計算最近站點]
  → getUserRouteId(userId) [Redis 讀取舊路線]
  → 若路線不同 → 通知「路線已切換」
  → setUserRouteId(userId, routeId) [Redis 寫入新路線]
```

### 2. 查詢 ETA

```
用戶查詢 → handleTextMessage()
  → getUserByLineId() [確認有綁定位置]
  → get_user_coords() [Supabase RPC 取座標]
  → calculateEta(lat, lng)
      → getNearestStop() [PostGIS，回傳最多 20 個站點]
      → 篩選有即時車輛的站點（先查 HCCG API）
      → syncSingleTruckFromHccg(routeId) [只查單一路線 GPS]
      → Redis fallback（限 6 小時內資料）
      → 若主路線無車 → 嘗試 100m 內其他路線
  → buildEtaMessages() [Flex Message 卡片]
```

### 3. 背景同步（Cron）

```
Vercel Cron 每 5 分鐘
  → /api/cron/sync-trucks
  → syncTrucksFromHccg() [全區 130+ 台車]
  → 驗證座標（台灣邊界 + 0,0 過濾）
  → 瞬移偵測（Teleport Detection）
  → setTruckLiveData(routeId, liveData) [Redis TTL 300s]
```

## 目錄結構

```
EcoTrack/
├── api/
│   ├── webhook.ts          # LINE Webhook 主入口
│   └── cron/
│       └── sync-trucks.ts  # 每 5 分鐘 GPS 同步
├── src/
│   ├── config/index.ts     # 環境變數集中管理
│   ├── services/
│   │   ├── truck.service.ts  # 核心 ETA 計算 + HCCG API
│   │   ├── user.service.ts   # Supabase 使用者操作
│   │   └── line.service.ts   # LINE Flex Message 建立
│   ├── types/index.d.ts    # TypeScript 型別定義
│   └── utils/
│       └── geo.util.ts     # Haversine 距離、瞬移偵測
├── supabase/
│   ├── migrations/001_init.sql  # 完整 DB schema
│   └── seeds/001_xiangshan_routes.sql  # 424 個真實站點
└── docs/                   # 📖 技術文件（本資料夾）
```
