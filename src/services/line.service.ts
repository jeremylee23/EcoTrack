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
  // If no truck coordinates, just fallback to text
  if (eta.truckLat === undefined || eta.truckLng === undefined) {
    return [buildTextMessage(eta.message)];
  }

  // Construct Map URL
  const baseUrl = "https://ecotrack-hsinchu.vercel.app/map";
  const params = new URLSearchParams();
  if (eta.userLat) params.append("uLat", eta.userLat.toString());
  if (eta.userLng) params.append("uLng", eta.userLng.toString());
  if (eta.stopLat) params.append("sLat", eta.stopLat.toString());
  if (eta.stopLng) params.append("sLng", eta.stopLng.toString());
  params.append("tLat", eta.truckLat.toString());
  params.append("tLng", eta.truckLng.toString());
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
  
  const mapUrl = `${baseUrl}?${params.toString()}`;

  // Build Flex Message
  const flexMessage: FlexMessage = {
    type: "flex",
    altText: `垃圾車預估 ETA: ${eta.etaMinutes ?? "?"} 分鐘`,
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
                text: eta.etaMinutes !== undefined && eta.etaMinutes <= 1 ? "即將抵達" : `約 ${eta.etaMinutes ?? "?"} 分`,
                weight: "bold",
                size: "lg",
                color: eta.etaMinutes !== undefined && eta.etaMinutes <= 1 ? "#ef4444" : "#3b82f6",
                margin: "md",
                flex: 1
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
                text: eta.recyclingEtaMinutes !== undefined ? (eta.recyclingEtaMinutes <= 1 ? "即將抵達" : `約 ${eta.recyclingEtaMinutes} 分`) : "無資料",
                weight: "bold",
                size: "lg",
                color: eta.recyclingEtaMinutes !== undefined && eta.recyclingEtaMinutes <= 1 ? "#ef4444" : "#10b981",
                margin: "md",
                flex: 1
              }
            ]
          },
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
                    text: "表定",
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
              }
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
                color: "#10b981",
                height: "sm",
                action: {
                  type: "uri",
                  label: "🗺️ 開啟即時追蹤地圖",
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

export function buildLocationConfirmMessage(address: string): TextMessage {
  return buildTextMessage(
    `📍 已記錄您的位置！\n` +
      `📌 地址：${address}\n\n` +
      `✅ 設定完成！未來點擊「查詢」時，我將為您計算離此地最近的垃圾車動態。\n\n` +
      `💡 您可以隨時傳送新的位置來更新設定。\n` +
      `🔍 查詢：點擊下方「查詢垃圾車 ETA」即可查看。`
  );
}

export function buildWelcomeMessage(): TextMessage {
  return buildTextMessage(
    `👋 歡迎使用新竹市垃圾車追蹤 Bot！\n\n` +
      `🗺️ 使用方式：\n` +
      `1️⃣ 點擊下方「📍 設定住家位置」\n` +
      `2️⃣ 點擊下方「🚛 查詢垃圾車 ETA」\n\n` +
      `📡 服務範圍：新竹市全市\n` +
      `⚡ 即時連線：保證為您抓取當下的即時 GPS 座標`
  );
}
