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

Vercel Cron Job
  /api/cron/sync-trucks.ts     (每日 00:00 UTC；Hobby 僅支援每日 cron)
GitHub Actions
  Keep Supabase Alive          (每 6 小時打 /api/health)
  Notify Approaching Trucks    (每 10 分鐘 → /api/cron/notify-approaching)
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
  → getUserPrefs() [半徑／定位模式／最愛追蹤點]
  → getActiveCoords() [最愛或住家]
  → calculateEta(lat, lng, { locateMode, radiusMeters })
      → HCCG getPointData（radius + locatemode，對齊官方）
      → 今日無收運 → 直接回下次清運時間（優於官方彈窗）
      → syncSingleTruckFromHccg(routeId) + Redis fallback
      → 附近待清運點 → 地圖 overlay
  → buildEtaMessages() [Flex Message 卡片]
```

### 2b. 進階文字指令（對齊並勝過官方清運網）

| 指令 | 功能 |
|------|------|
| 底部 Rich Menu（6 鍵） | 定位／垃圾車／班表／最愛／搜尋／說明 |
| `班表` | 整週清運日＋歷史平均 |
| `查 中正路` | 關鍵字／路名搜尋＋距離排序 |
| `半徑 200` | 搜尋半徑 50–500（預設 100） |
| `模式 推薦` / `模式 整天` | 對齊官方自動／全部顯示 |
| `收藏 公司` / `切換 公司` / `最愛` | 最多 3 個追蹤點（Redis） |
| `通知 開` / `通知 關` | 靠近推播開關 |
| `設定` | 一次看目前模式／半徑／最愛 |

### 3. 背景同步與提醒

```
Vercel Cron
  每日 00:00 UTC → /api/cron/sync-trucks（全區 GPS → Redis）
  （Hobby 方案僅允許每日 cron；更頻繁的 keep-alive 改由 GitHub Actions）

GitHub Actions
  每 6 小時  → Keep Supabase Alive（打 /api/health，檢查 database=connected）
  每 10 分鐘 → Notify Approaching（ETA≤5 分鐘 LINE Push）
```

## 目錄結構

```
EcoTrack/
├── api/
│   ├── webhook.ts          # LINE Webhook 主入口
│   └── cron/
│       ├── sync-trucks.ts         # 每日 GPS 同步
│       └── notify-approaching.ts  # 靠近 5 分鐘推播
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
