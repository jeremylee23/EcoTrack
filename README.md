# 🚛 EcoTrack Hsinchu (新竹市垃圾車即時追蹤 Bot)

EcoTrack 是一個專為新竹市民打造的 LINE Bot，旨在解決「不知道垃圾車什麼時候來」的痛點。透過串接新竹市政府開放資料與地理資訊系統，我們提供了即時的垃圾車預估到站時間（ETA）、動態追蹤地圖、以及基於位置的提醒功能。

## ✨ 核心特色功能

1.  **📍 智慧位置綁定**
    *   使用者透過 LINE 傳送 GPS 位置，系統會利用 PostGIS 空間演算法，自動比對並記錄距離最近的清運站點。
2.  **即時 ETA 查詢與 Flex Message 視覺化追蹤**
    *   點擊常駐的圖文選單，系統會立即向政府伺服器抓取最新的全區垃圾車 GPS 訊號。
    *   結合用戶座標與車輛位置，計算出精準的預估抵達時間（ETA）。
    *   回覆具有高質感的 **LINE Flex Message 卡片**，顯示車牌、站點與倒數時間。
3.  **🗺️ 全螢幕網頁地圖 (Web Map)**
    *   免下載 App、免登入！點擊卡片即可在 LINE 內部直接開啟全螢幕地圖。
    *   地圖上會同時標示「您的位置」、「垃圾車位置」與「清運站點」，並畫出虛線幫助視覺化距離。
4.  **📊 機器學習準備：ETA 誤差數據收集**
    *   每次查詢皆會在 Supabase 記錄「預估時間」，當垃圾車實際抵達站點時，系統會自動在背景補齊「實際抵達時間」。
    *   這套架構將隨著時間累積大量數據，未來將用於訓練專屬的 ML 模型，進一步優化 ETA 演算法。

## 🛠️ 技術架構 (Tech Stack)

*   **Runtime & Hosting**: [Vercel](https://vercel.com/) (Serverless Functions)
*   **Database**: [Supabase](https://supabase.com/) (PostgreSQL + PostGIS)
*   **Cache & In-Memory Storage**: [Upstash Redis](https://upstash.com/)
*   **Bot Framework**: LINE Messaging API SDK v8 (@line/bot-sdk)
*   **Frontend**: HTML5 + CSS3 + [Leaflet.js](https://leafletjs.com/) (輕量化互動地圖)
*   **Language**: TypeScript / Node.js

## 🗂️ 專案目錄結構

```text
EcoTrack/
├── api/
│   ├── cron/
│   │   └── sync-trucks.ts       # 每日例行排程同步 (Vercel Cron)
│   └── webhook.ts               # LINE Bot 訊息與事件處理入口
├── public/
│   └── map.html                 # 全螢幕地圖前端頁面
├── scripts/
│   ├── seed-all-districts.js    # 匯入全新竹市路線與站點腳本
│   └── setup-rich-menu.js       # LINE 圖文選單產生與綁定腳本
├── src/
│   ├── config/                  # 環境變數與全域設定
│   ├── services/
│   │   ├── line.service.ts      # 封裝 LINE API 訊息格式 (Flex Message)
│   │   ├── truck.service.ts     # 串接政府 API、Redis 快取與 ETA 演算法
│   │   └── user.service.ts      # 操作 Supabase 與 PostGIS 查詢
│   ├── types/                   # TypeScript 型別定義
│   └── utils/                   # 工具函式 (地理演算、經緯度轉換)
├── supabase/
│   └── migrations/              # 資料庫建立語法 (包含 route_stops, users, eta_logs)
├── package.json
└── vercel.json                  # Vercel 路由與 Cron 設定
```

## 🚀 部署與執行

### 環境變數設定 (.env)
部署前請確保已設定以下環境變數：
*   `LINE_CHANNEL_ACCESS_TOKEN` / `LINE_CHANNEL_SECRET`
*   `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`
*   `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`

### Vercel 部署
專案已完全配置好 Vercel 的部署規則。只需推送代碼至 GitHub，Vercel 即會自動讀取 `vercel.json` 進行部署。

```bash
vercel --prod
```

## 🤝 貢獻與未來展望
目前我們已成功涵蓋新竹市「東區、北區、香山區」全區資料。下一步我們將：
1.  **導入 LINE Notify**：解決 Messaging API 的推播則數限制，實現「垃圾車靠近前 5 分鐘自動推播」的零成本架構。
2.  **ETA 模型訓練**：利用 `eta_logs` 累積的數據，改善目前單純依靠均速計算的 ETA 演算法。

---
*Developed by Jeremy Lee / 2026*
