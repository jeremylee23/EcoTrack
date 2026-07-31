# EcoTrack 架構優化紀錄

本次針對跨模組重複、啟動耦合、API 邊界與 webhook 入口過胖做了五項低風險但高槓桿的整理。

## 1. 共用基礎設施 client 工廠

- 新增 `src/services/clients.ts`
- 統一管理 Redis、Supabase、LINE Messaging API、Gemini client 的 lazy singleton 初始化
- 讓 service 不再各自維護一份初始化邏輯，後續要做 mock、觀測或連線策略調整時只需改一處

## 2. 將 RAG 依賴降為選配

- `src/config/index.ts` 中的 `GEMINI_API_KEY` 改為選配
- `src/services/rag.service.ts` 改為只有在真正需要問答或 embedding 時才初始化 Gemini
- 沒有 Gemini key 時，查車、班表、通知、cron 等主流程不會因為 import RAG service 而啟動失敗

## 3. API handler 工具化

- 新增 `src/utils/api-handler.util.ts`
- 收斂重複的 CORS、OPTIONS、method guard、cron authorization、錯誤 JSON 格式
- 目前已套用在 `api/webhook.ts`、`api/route-path.ts`、`api/static-map.ts`、`api/cron/*.ts`

## 4. 跨層常數集中管理

- 新增 `src/config/constants.ts`
- 收斂地圖版本號、提醒閾值與 truck service 調校常數
- 演算法參數與前端 map 版本不再散落在多個 service / handler 中

## 5. Webhook 入口瘦身與應用層抽離

- 新增 `src/webhook/handlers.ts`
- 將 LINE follow / location / text 事件處理從 `api/webhook.ts` 抽離
- `api/webhook.ts` 現在只負責驗簽、解包 request body、批次轉派事件與回傳 HTTP 結果
- webhook HTTP 入口由 900+ 行降到約 60 行，後續要拆指令、補測試或改 reply 策略時，變更面會集中在 webhook 應用層模組

## 驗證

- `npm run typecheck`
- RAG fallback 已改為在沒有 Gemini key 時仍可安全載入，並回傳可預期的降級訊息

## 下一階段建議

- 拆分 `api/webhook.ts` 的文字指令路由，將 command dispatch 與 reply 組裝移出入口檔
- 為 service 層建立 mockable 單元測試，覆蓋 Redis/Supabase 邊界與 fallback 行為