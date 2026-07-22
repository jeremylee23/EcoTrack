/**
 * services/line.service.ts
 * Wraps LINE Messaging API v8 (MessagingApiClient) for sending replies and push messages.
 */

import { messagingApi } from "@line/bot-sdk";
import type { webhook } from "@line/bot-sdk";
import { config } from "../config/index.js";
import type { EtaResult } from "../types/index.js";

// Re-export useful types for use in webhook.ts
export type TextMessage = messagingApi.TextMessage;
export type LocationMessage = messagingApi.LocationMessage;
export type FlexMessage = messagingApi.FlexMessage;
export type Message = messagingApi.Message;

// ── Singleton LINE MessagingApiClient ────────────────────────

let _client: messagingApi.MessagingApiClient | null = null;

function getLineClient(): messagingApi.MessagingApiClient {
  if (!_client) {
    _client = new messagingApi.MessagingApiClient({
      channelAccessToken: config.line.channelAccessToken,
    });
  }
  return _client;
}

// ── Reply / Push ─────────────────────────────────────────────

export async function replyMessage(
  replyToken: string,
  messages: Message[]
): Promise<void> {
  const client = getLineClient();
  await client.replyMessage({ replyToken, messages });
}

export async function pushMessage(
  userId: string,
  messages: Message[]
): Promise<void> {
  const client = getLineClient();
  await client.pushMessage({ to: userId, messages });
}

// ── Message builders ─────────────────────────────────────────

// Removed withQuickReply as we now use Rich Menu

export function buildTextMessage(text: string): TextMessage {
  return { type: "text", text };
}

export function buildLocationMessage(
  title: string,
  address: string,
  lat: number,
  lng: number
): LocationMessage {
  return { type: "location", title, address, latitude: lat, longitude: lng };
}

export function buildEtaMessages(eta: EtaResult): Message[] {
  // If no truck coordinates and no next dates, just fallback to text
  if (
    eta.truckLat === undefined &&
    eta.truckLng === undefined &&
    eta.etaMinutes === undefined &&
    eta.recyclingEtaMinutes === undefined &&
    !eta.nextGarbageDate &&
    !eta.nextRecycleDate &&
    !eta.noServiceToday
  ) {
    return [buildTextMessage(eta.message)];
  }

  // Construct Map URL
  const baseUrl = "https://ecotrack-hsinchu.vercel.app/map";
  const params = new URLSearchParams();
  if (eta.userLat) params.append("uLat", eta.userLat.toString());
  if (eta.userLng) params.append("uLng", eta.userLng.toString());
  if (eta.stopLat) params.append("sLat", eta.stopLat.toString());
  if (eta.stopLng) params.append("sLng", eta.stopLng.toString());
  if (eta.truckLat !== undefined) params.append("tLat", eta.truckLat.toString());
  if (eta.truckLng !== undefined) params.append("tLng", eta.truckLng.toString());
  if (eta.carNo) params.append("car", eta.carNo);
  if (eta.recyclingTruckLat && eta.recyclingTruckLng) {
    params.append("rLat", eta.recyclingTruckLat.toString());
    params.append("rLng", eta.recyclingTruckLng.toString());
  }
  if (eta.recyclingCarNo) params.append("rCar", eta.recyclingCarNo);
  if (eta.nearestStopName || eta.nearestStopAddress) {
    params.append("stop", eta.nearestStopName || eta.nearestStopAddress || "");
  }
  if (eta.etaMinutes !== undefined) params.append("eta", eta.etaMinutes.toString());
  if (eta.noServiceToday) params.append("noService", "1");
  if (
    eta.etaMinutes === undefined &&
    !eta.nextGarbageDate &&
    eta.scheduledTime &&
    !eta.noServiceToday
  ) {
    params.append("waiting", "1");
  }
  // Compact nearby uncleared points (official map shows uncleared; we overlay them)
  if (eta.nearbyUncleared && eta.nearbyUncleared.length > 0) {
    const near = eta.nearbyUncleared
      .slice(0, 8)
      .map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`)
      .join("|");
    params.append("near", near);
    params.append("nearN", String(Math.min(8, eta.nearbyUncleared.length)));
  }
  if (eta.radiusMeters) params.append("radius", String(eta.radiusMeters));
  const mapUrl = `${baseUrl}?${params.toString()}`;

  const altText = eta.noServiceToday
    ? `今日無收運｜下次 ${eta.nextGarbageDate ?? eta.nextRecycleDate ?? "見班表"}`
    : `垃圾車預估 ETA: ${eta.etaMinutes ?? "?"} 分鐘`;

  // Build Flex Message
  const flexMessage: FlexMessage = {
    type: "flex",
    altText,
    contents: {
      type: "bubble",
      size: "giga",
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "20px",
        contents: [
          {
            type: "box",
            layout: "horizontal",
            alignItems: "center",
            contents: [
              {
                type: "text",
                text: "🚛",
                size: "xl",
                flex: 0
              },
              {
                type: "text",
                text: eta.noServiceToday
                  ? (eta.nextGarbageDate ? `今日無收運｜下次 ${eta.nextGarbageDate}` : "今日無收運")
                  : eta.nextGarbageDate
                  ? (eta.isGarbagePassed ? `已過站，下次 ${eta.nextGarbageDate}` : `下次 ${eta.nextGarbageDate}`)
                  : (eta.etaMinutes !== undefined && eta.etaMinutes <= 1 
                    ? "即將抵達" 
                    : (eta.etaMinutes !== undefined
                      ? `預估 ${formatAbsoluteTime(eta.etaMinutes)} (${eta.etaMinutes}分)`
                      : (eta.scheduledTime ? `表定 ${eta.scheduledTime}（等待訊號）` : "未知"))),
                weight: "bold",
                size: eta.nextGarbageDate || eta.noServiceToday ? "sm" : (eta.etaMinutes === undefined && eta.scheduledTime ? "sm" : "md"),
                color: eta.noServiceToday
                  ? "#dc2626"
                  : eta.nextGarbageDate ? "#9ca3af" : (eta.etaMinutes !== undefined && eta.etaMinutes <= 1 ? "#ef4444" : (eta.etaMinutes === undefined ? "#f59e0b" : "#3b82f6")),
                margin: "md",
                flex: 1,
                wrap: true
              },
              {
                type: "text",
                text: "♻️",
                size: "xl",
                flex: 0,
                margin: "md"
              },
              {
                type: "text",
                text: eta.noServiceToday
                  ? (eta.nextRecycleDate ? `下次 ${eta.nextRecycleDate}` : "今日無回收")
                  : eta.nextRecycleDate
                  ? (eta.isRecyclePassed ? `已過站，下次 ${eta.nextRecycleDate}` : `下次 ${eta.nextRecycleDate}`)
                  : (eta.recyclingEtaMinutes !== undefined 
                    ? (eta.recyclingEtaMinutes <= 1 ? "即將抵達" : `預估 ${formatAbsoluteTime(eta.recyclingEtaMinutes)} (${eta.recyclingEtaMinutes}分)`) 
                    : (eta.scheduledTime && !eta.nextGarbageDate ? `表定 ${eta.scheduledTime}` : "無資料")),
                weight: "bold",
                size: eta.nextRecycleDate || eta.noServiceToday ? "sm" : "md",
                color: eta.noServiceToday
                  ? "#9ca3af"
                  : eta.nextRecycleDate ? "#9ca3af" : (eta.recyclingEtaMinutes !== undefined && eta.recyclingEtaMinutes <= 1 ? "#ef4444" : "#10b981"),
                margin: "md",
                flex: 1,
                wrap: true
              }
            ]
          },
          ...(eta.noServiceToday ? [{
            type: "box" as const,
            layout: "vertical" as const,
            margin: "md" as const,
            paddingAll: "sm" as const,
            backgroundColor: "#fef2f2" as const,
            cornerRadius: "sm" as const,
            contents: [
              {
                type: "text" as const,
                text: "🚫 官方只顯示「今日無收運服務」；我們直接附上下次清運時間。傳「班表」可看整週。",
                color: "#991b1b" as const,
                size: "xs" as const,
                wrap: true
              }
            ]
          }] : []),
          ...(eta.isStale ? [{
            type: "box" as const,
            layout: "vertical" as const,
            margin: "md" as const,
            paddingAll: "sm" as const,
            backgroundColor: (eta.staleMinutes ?? 0) > 120 ? "#fffbeb" : "#fef2f2",
            cornerRadius: "sm" as const,
            contents: [
              {
                type: "text" as const,
                text: (eta.staleMinutes ?? 0) > 120
                  ? `⚠️ GPS 訊號已超過 ${Math.round((eta.staleMinutes ?? 0) / 60)} 小時未更新（預估僅供參考）\n💡 這不代表車輛閒置，昨日垃圾車仍可能正常出動，建議於表定時間前 30 分鐘再查。`
                  : `⚠️ GPS 已 ${eta.staleMinutes} 分鐘未更新，預估時間可能不準確。`,
                color: (eta.staleMinutes ?? 0) > 120 ? "#92400e" : "#dc2626",
                size: "xs" as const,
                wrap: true
              }
            ]
          }] : []),
          ...(eta.etaMinutes === undefined && !eta.nextGarbageDate && eta.scheduledTime && !eta.noServiceToday ? [{
            type: "box" as const,
            layout: "vertical" as const,
            margin: "md" as const,
            paddingAll: "sm" as const,
            backgroundColor: "#fffbeb" as const,
            cornerRadius: "sm" as const,
            contents: [
              {
                type: "text" as const,
                text: "📡 今日仍可能來車，但目前沒有可用即時 GPS。建議稍後再查，或依表定時間提早等候。",
                color: "#92400e" as const,
                size: "xs" as const,
                wrap: true
              }
            ]
          }] : []),
          ...(eta.usedAlternateRoute ? [{
            type: "box" as const,
            layout: "vertical" as const,
            margin: "md" as const,
            paddingAll: "sm" as const,
            backgroundColor: "#eff6ff" as const,
            cornerRadius: "sm" as const,
            contents: [
              {
                type: "text" as const,
                text: "🔄 原路線暫無訊號，已改追蹤附近 100 公尺內有車的替代路線。",
                color: "#1d4ed8" as const,
                size: "xs" as const,
                wrap: true
              }
            ]
          }] : []),
          ...((eta.nearbyUncleared?.length ?? 0) > 1 ? [{
            type: "box" as const,
            layout: "vertical" as const,
            margin: "md" as const,
            paddingAll: "sm" as const,
            backgroundColor: "#fff7ed" as const,
            cornerRadius: "sm" as const,
            contents: [
              {
                type: "text" as const,
                text: `🚩 附近待清運點 ${eta.nearbyUncleared!.length} 處（地圖可一次看完，優於官方逐點點選）`,
                color: "#9a3412" as const,
                size: "xs" as const,
                wrap: true
              }
            ]
          }] : []),
          ...(eta.garbageEtaSource || eta.recyclingEtaSource ? [{
            type: "box" as const,
            layout: "baseline" as const,
            margin: "sm" as const,
            contents: [
              {
                type: "text" as const,
                text: "來源",
                color: "#aaaaaa" as const,
                size: "xs" as const,
                flex: 1
              },
              {
                type: "text" as const,
                text: [
                  eta.garbageEtaSource
                    ? `🚛 ${eta.garbageEtaSource === "official" ? "官方即時" : "距離推估"}`
                    : null,
                  eta.recyclingEtaSource
                    ? `♻️ ${eta.recyclingEtaSource === "official" ? "官方即時" : "距離推估"}`
                    : null,
                ].filter(Boolean).join("  "),
                color: "#666666" as const,
                size: "xs" as const,
                flex: 4,
                wrap: true
              }
            ]
          }] : []),
          {
            type: "separator",
            margin: "md"
          },
          {
            type: "box",
            layout: "vertical",
            margin: "md",
            spacing: "sm",
            contents: [
              {
                type: "box",
                layout: "baseline",
                spacing: "sm",
                contents: [
                  {
                    type: "text",
                    text: "車牌",
                    color: "#aaaaaa",
                    size: "sm",
                    flex: 1
                  },
                  {
                    type: "text",
                    text: `🚛 ${eta.carNo || "未知"} \n♻️ ${eta.recyclingCarNo || "未知"}`,
                    wrap: true,
                    color: "#666666",
                    size: "sm",
                    flex: 4
                  }
                ]
              },
              {
                type: "box",
                layout: "baseline",
                spacing: "sm",
                contents: [
                  {
                    type: "text",
                    text: "站點",
                    color: "#aaaaaa",
                    size: "sm",
                    flex: 1
                  },
                  {
                    type: "text",
                    text: eta.nearestStopName || eta.nearestStopAddress || "未知",
                    wrap: true,
                    color: "#666666",
                    size: "sm",
                    flex: 4
                  }
                ]
              },
              {
                type: "box",
                layout: "baseline",
                spacing: "sm",
                contents: [
                  {
                    type: "text",
                    text: "官方表定",
                    color: "#aaaaaa",
                    size: "sm",
                    flex: 1
                  },
                  {
                    type: "text",
                    text: eta.scheduledTime || "未知",
                    wrap: true,
                    color: "#666666",
                    size: "sm",
                    flex: 4
                  }
                ]
              },
              ...(eta.locateMode || eta.radiusMeters ? [{
                type: "box" as const,
                layout: "baseline" as const,
                spacing: "sm" as const,
                contents: [
                  {
                    type: "text" as const,
                    text: "搜尋",
                    color: "#aaaaaa",
                    size: "sm" as const,
                    flex: 1
                  },
                  {
                    type: "text" as const,
                    text: `${eta.locateMode === "all_day" ? "整天班表" : "依時間推薦"}｜半徑 ${eta.radiusMeters ?? 100}m`,
                    wrap: true,
                    color: "#666666",
                    size: "sm" as const,
                    flex: 4
                  }
                ]
              }] : []),
              ...(eta.historicalAvgTime ? [{
                type: "box" as const,
                layout: "baseline" as const,
                spacing: "sm" as const,
                contents: [
                  {
                    type: "text" as const,
                    text: "歷史平均",
                    color: "#aaaaaa",
                    size: "sm" as const,
                    flex: 1
                  },
                  {
                    type: "text" as const,
                    text: eta.historicalAvgTime,
                    wrap: true,
                    color: "#666666",
                    size: "sm" as const,
                    flex: 4
                  }
                ]
              }] : [])
            ]
          },
          {
            type: "box",
            layout: "vertical",
            margin: "xl",
            contents: [
              {
                type: "button",
                style: "primary",
                color: eta.noServiceToday
                  ? "#6b7280"
                  : (!eta.nextGarbageDate && !eta.nextRecycleDate) ? "#10b981" : "#d1d5db",
                height: "sm",
                action: {
                  type: "uri",
                  label: eta.noServiceToday
                    ? "🗺️ 開啟地圖（看站點）"
                    : "🗺️ 開啟即時追蹤地圖",
                  uri: mapUrl
                }
              }
            ]
          }
        ]
      }
    }
  };

  return [flexMessage];
}

export function buildLocationConfirmMessage(
  address: string,
  extraNotice = ""
): TextMessage {
  return buildTextMessage(
    `📍 已記錄您的位置！\n` +
      `📌 地址：${address}` +
      (extraNotice ? `\n${extraNotice}` : "") +
      `\n\n✅ 設定完成！傳「垃圾車」查即時 ETA，傳「班表」看整週。\n` +
      `⭐ 收藏 公司｜切換 公司｜最愛\n` +
      `📏 半徑 200｜⚙️ 模式 推薦｜整天｜🔍 查 路名`
  );
}

export function buildWelcomeMessage(): TextMessage {
  return buildTextMessage(
    `👋 歡迎使用 EcoTrack（比官方清運網更快一層）\n\n` +
      `📍 先傳 GPS 綁定住家，再試這些指令：\n` +
      `• 垃圾車 → 即時 ETA＋靠近推播\n` +
      `• 班表 → 整週清運日（優於官方彈窗）\n` +
      `• 查 中正路 → 關鍵字搜尋＋距離排序\n` +
      `• 半徑 50~500｜模式 推薦／整天\n` +
      `• 收藏 公司｜切換 公司｜最愛（最多 3 點）\n\n` +
      `🗺️ 地圖可一次看附近待清運點\n` +
      `📡 服務範圍：新竹市全市`
  );
}

function formatAbsoluteTime(etaMinutes: number): string {
  const now = new Date();
  // Using Taiwan time (UTC+8) to safely format
  const targetTime = new Date(now.getTime() + etaMinutes * 60000 + (8 * 3600000));
  const h = targetTime.getUTCHours().toString().padStart(2, "0");
  const m = targetTime.getUTCMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
}
