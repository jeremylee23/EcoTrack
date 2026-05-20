# HCCG API 逆向工程紀錄

## 官方網站

`https://7966.hccg.gov.tw`（新竹市環保局便民查詢網）

> ⚠️ 此 API 無需申請 Key，但屬於公共服務，請勿高頻率呼叫。

---

## 已發現的 API Endpoints

### 1. 取得車輛即時 GPS

```
GET https://7966.hccg.gov.tw/WEB/_IMP/API/CleanWeb/getCarLocation?rId={routeId}
```

| 參數 | 說明 | 範例 |
|------|------|------|
| `rId` | 路線 ID，`all` 代表全區 | `181` 或 `all` |

**回應格式：**
```json
{
  "statusCode": 1,
  "message": "success",
  "data": {
    "total": 2,
    "car": [
      {
        "routeId": "181",
        "routeName": "香山大庄路線",
        "carType": "0",        // "0"=垃圾車, "1"=回收車
        "carNo": "262-S2",
        "carStatus": "0",      // "0"=進行中, "1"=完成
        "lat": "24.7892",
        "lon": "120.9234",
        "seq": "12",           // 目前前往的站點序號
        "updateTime": "2026/05/20 16:05:23",
        "direction": "1",
        "leave": "0",
        "address": "香山區大庄路..."
      }
    ]
  }
}
```

---

### 2. 取得所有停靠站點

```
GET https://7966.hccg.gov.tw/WEB/_IMP/API/CleanWeb/getPointData?address=
```

| 參數 | 說明 |
|------|------|
| `address` | 空值代表全部，可填地址關鍵字篩選 |

需加 Header：`Referer: https://7966.hccg.gov.tw/WEB/cleanPoint.html`

**回應格式（重要欄位）：**
```json
{
  "data": {
    "cleanPoint": [
      {
        "routeId": "181",
        "routeName": "香山大庄路線",
        "pointId": "A001",
        "pointName": "大庄路口",
        "address": "香山區大庄路1號",
        "lat": "24.7892",
        "lon": "120.9234",
        "district": "3",       // "3" = 香山區
        "trashDay": "1,2,4,5,6",  // 收垃圾的星期（1=週一）
        "recycleDay": "1,5",      // 回收日
        "time": "18:20~18:21",    // 預計到達時間範圍
        "seq": "12",
        "status": "0"
      }
    ]
  }
}
```

---

### 3. 取得路線資料

```
GET https://7966.hccg.gov.tw/WEB/_IMP/API/CleanWeb/getRouteData
```

回傳全區所有路線清單，包含 `routeId`、`routeName`、`trashDay`、`recycleDay`。

---

## 逆向工程方法

透過分析官方網站前端 JavaScript（`/WEB/js/cleanPoint.js`）發現呼叫模式：

1. 用 `curl` 抓取 HTML 原始碼
2. 找到 `fetch` / `ajax` 呼叫
3. 確認 API 參數格式與 `Referer` Header 需求

---

## 重要注意事項

### GPS 訊號說明
- HCCG API 回傳的 `updateTime` 是車輛 GPS 最後回報時間
- **GPS 停滯 ≠ 車輛閒置**：車輛的 GPS 設備可能在行駛中關閉或訊號中斷，不代表該車當日沒有出勤
- 建議：`updateTime` 超過 **6 小時**的資料視為「今日暫無訊號」

### carType 說明
| carType | 車種 |
|---------|------|
| `"0"` | 垃圾車 (general waste) |
| `"1"` | 回收車 (recycling) |

### 座標驗證
API 偶爾會回傳無效座標，系統自動過濾：
- `(0, 0)` 無效座標
- 超出台灣地理邊界（lat: 21.5–25.5, lng: 119.5–122.5）
- 瞬移偵測：兩次 GPS 更新之間移動距離超過合理速度
