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

/** Compact quick replies under the last bubble (complements the 6-cell Rich Menu). */
export const MAIN_QUICK_REPLIES: messagingApi.QuickReplyItem[] = [
  {
    type: "action",
    action: { type: "message", label: "🚛 垃圾車", text: "垃圾車" },
  },
  {
    type: "action",
    action: { type: "message", label: "🗺️ 附近", text: "附近清運點" },
  },
  {
    type: "action",
    action: { type: "message", label: "📅 班表", text: "班表" },
  },
  {
    type: "action",
    action: { type: "message", label: "⭐ 最愛", text: "最愛" },
  },
  {
    type: "action",
    action: { type: "message", label: "📖 說明", text: "說明" },
  },
];

export function withQuickReply(
  message: Message,
  items: messagingApi.QuickReplyItem[] = MAIN_QUICK_REPLIES
): Message {
  return {
    ...message,
    quickReply: { items },
  };
}

export function attachQuickReplyToLast(
  messages: Message[],
  items: messagingApi.QuickReplyItem[] = MAIN_QUICK_REPLIES
): Message[] {
  if (messages.length === 0) return messages;
  const next = [...messages];
  next[next.length - 1] = withQuickReply(next[next.length - 1], items);
  return next;
}

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
    return attachQuickReplyToLast([buildTextMessage(eta.message)]);
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
  if (eta.routeId) params.append("routeId", eta.routeId);
  if (eta.routeName) params.append("routeName", eta.routeName);
  // Prefer corridor around user; fall back to stop
  const pathLat = eta.userLat ?? eta.stopLat;
  const pathLng = eta.userLng ?? eta.stopLng;
  if (pathLat !== undefined) params.append("pathLat", String(pathLat));
  if (pathLng !== undefined) params.append("pathLng", String(pathLng));
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
          ...(eta.routeName && !eta.noServiceToday ? [{
            type: "box" as const,
            layout: "vertical" as const,
            margin: "md" as const,
            paddingAll: "sm" as const,
            backgroundColor: "#eff6ff" as const,
            cornerRadius: "sm" as const,
            contents: [
              {
                type: "text" as const,
                text:
                  `🛣️ 地圖會畫出「${eta.routeName}」完整路線（藍線）\n` +
                  `橘色「在這等」＝離你家最近的路點＋預估時間。\n` +
                  `沿路收不一定有旗子，往藍線靠近等就好。`,
                color: "#1e3a8a" as const,
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
                    : "🗺️ 看路線地圖（往藍線等）",
                  uri: mapUrl
                }
              }
            ]
          }
        ]
      }
    }
  };

  return attachQuickReplyToLast([flexMessage]);
}

export function buildLocationConfirmMessage(
  address: string,
  extraNotice = ""
): TextMessage {
  return withQuickReply(
    buildTextMessage(
      `📍 已記住「定位存的地方」\n` +
        `📌 ${address}` +
        (extraNotice ? `\n${extraNotice}` : "") +
        `\n\n👉 接下來請點下面「🚛 垃圾車」\n` +
        `若還要存兒子家、公司：點選單「⭐ 最愛」→「新增地方」`
    )
  ) as TextMessage;
}

export function buildWelcomeMessage(): TextMessage {
  return withQuickReply(
    buildTextMessage(
      `👋 歡迎使用新竹垃圾車提醒\n\n` +
        `長輩只要點大按鈕：\n` +
        `1️⃣ 定位 → 傳你平常倒垃圾的位置（會記住門牌）\n` +
        `2️⃣ 垃圾車 → 看何時到\n` +
        `3️⃣ 班表 → 哪幾天有收\n` +
        `4️⃣ 最愛 → 換地方查（每個地方都寫門牌）\n` +
        `5️⃣ 附近 → 看哪裡可倒（有圖有地圖）\n` +
        `6️⃣ 說明\n\n` +
        `「定位存的地方」＝你用「定位」傳過的那一點；\n` +
        `「最愛」＝另外加的地方（兒子家、公司等）。\n` +
        `家人可幫最愛加暱稱，地址仍會顯示。`
    )
  ) as TextMessage;
}

/**
 * One-tap place picker: every option shows a real address — never abstract「住家」alone.
 */
export function buildFavoritesMenuFlex(options: {
  favorites: Array<{
    id: string;
    label: string;
    nickname?: string;
    address?: string;
  }>;
  activeLabel: string;
  activeId?: string | null;
  /** Doorplate from last 「定位」 — required for seniors to recognize the first option */
  homeAddress?: string;
}): FlexMessage {
  const { favorites, activeId, homeAddress } = options;
  const isHome = !activeId;
  const homeAddr =
    homeAddress?.trim() ||
    "（還沒有門牌：請再點一次底部「定位」傳位置）";

  const homeBlock = {
    type: "box" as const,
    layout: "vertical" as const,
    spacing: "sm" as const,
    margin: "md" as const,
    paddingAll: "12px" as const,
    backgroundColor: isHome ? "#ecfdf5" : "#f9fafb",
    cornerRadius: "md" as const,
    contents: [
      {
        type: "text" as const,
        text: isHome ? "定位存的地方（使用中）" : "定位存的地方",
        weight: "bold" as const,
        size: "md" as const,
        color: "#111827",
        wrap: true,
      },
      {
        type: "text" as const,
        text: `📍 ${homeAddr}`,
        size: "sm" as const,
        color: "#4b5563",
        wrap: true,
      },
      {
        type: "text" as const,
        text: "＝ 你用底部「定位」傳過的位置（不是最愛裡的其他地方）",
        size: "xs" as const,
        color: "#6b7280",
        wrap: true,
        margin: "sm" as const,
      },
      {
        type: "button" as const,
        style: (isHome ? "primary" : "secondary") as "primary" | "secondary",
        color: isHome ? "#059669" : undefined,
        height: "sm" as const,
        margin: "sm" as const,
        action: {
          type: "message" as const,
          label: isHome ? "目前使用這個" : "選這個查車",
          text: "用住家",
        },
      },
    ],
  };

  const favBlocks = favorites.map((f) => {
    const active = f.id === activeId;
    const title = f.nickname?.trim() || f.label;
    const addressLine =
      f.address?.trim() ||
      (f.nickname?.trim() ? f.label : f.address !== f.label ? f.label : null);

    return {
      type: "box" as const,
      layout: "vertical" as const,
      spacing: "sm" as const,
      margin: "md" as const,
      paddingAll: "12px" as const,
      backgroundColor: active ? "#ecfdf5" : "#f9fafb",
      cornerRadius: "md" as const,
      contents: [
        {
          type: "text" as const,
          text: active ? `${title}（使用中）` : title,
          weight: "bold" as const,
          size: "md" as const,
          color: "#111827",
          wrap: true,
        },
        ...(addressLine
          ? [
              {
                type: "text" as const,
                text: `📍 ${addressLine}`,
                size: "sm" as const,
                color: "#4b5563",
                wrap: true,
              },
            ]
          : []),
        {
          type: "button" as const,
          style: (active ? "primary" : "secondary") as "primary" | "secondary",
          color: active ? "#059669" : undefined,
          height: "sm" as const,
          margin: "sm" as const,
          action: {
            type: "message" as const,
            label: active ? "目前使用這個" : "選這個查車",
            text: `用地點:${f.id}`,
          },
        },
      ],
    };
  });

  const nickHint =
    favorites.length > 0
      ? {
          type: "text" as const,
          text: "上面第一個＝定位存的；下面＝最愛裡加過的其他地方。",
          size: "sm" as const,
          color: "#6b7280",
          wrap: true,
          margin: "md" as const,
        }
      : {
          type: "text" as const,
          text: "若還要查兒子家、公司等，點下面「新增地方」。",
          size: "sm" as const,
          color: "#6b7280",
          wrap: true,
          margin: "md" as const,
        };

  return {
    type: "flex",
    altText: "要查哪裡的垃圾車？點一下就好",
    contents: {
      type: "bubble",
      size: "mega",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        paddingAll: "20px",
        contents: [
          {
            type: "text",
            text: "要查哪裡的車？",
            weight: "bold",
            size: "xl",
            color: "#111827",
          },
          {
            type: "text",
            text: "每個地方都會寫出門牌，點「選這個查車」即可。",
            size: "md",
            color: "#4b5563",
            wrap: true,
          },
          nickHint,
          { type: "separator", margin: "md" },
          homeBlock,
          ...favBlocks,
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          {
            type: "button",
            style: "primary",
            color: "#1d4ed8",
            height: "md",
            action: {
              type: "message",
              label: "➕ 新增地方",
              text: "新增地點",
            },
          },
          ...(favorites.length > 0
            ? [
                {
                  type: "button" as const,
                  style: "secondary" as const,
                  height: "md" as const,
                  action: {
                    type: "message" as const,
                    label: "✏️ 幫地方加暱稱",
                    text: "加暱稱",
                  },
                },
                {
                  type: "button" as const,
                  style: "secondary" as const,
                  height: "md" as const,
                  action: {
                    type: "message" as const,
                    label: "🗑 刪除地方",
                    text: "刪除地點",
                  },
                },
              ]
            : []),
        ],
      },
    },
  };
}

/** Ask to send GPS — no name picking. */
export function buildAskSendLocationFlex(
  purpose: "add" | "home" = "add"
): FlexMessage {
  const title =
    purpose === "add" ? "新增一個地方" : "用定位記住你的位置";
  const body =
    purpose === "add"
      ? "請按下面綠色按鈕傳位置。\n系統會自動用地址記住，不用取名。"
      : "請按下面綠色按鈕傳位置。\n之後選單會顯示「定位存的地方」＋門牌。";

  return {
    type: "flex",
    altText: title,
    contents: {
      type: "bubble",
      size: "mega",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        paddingAll: "20px",
        contents: [
          {
            type: "text",
            text: title,
            weight: "bold",
            size: "xl",
            wrap: true,
          },
          {
            type: "text",
            text: body,
            size: "md",
            color: "#4b5563",
            wrap: true,
          },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "button",
            style: "primary",
            color: "#059669",
            height: "md",
            action: {
              type: "uri",
              label: "📍 按這裡傳送位置",
              uri: "https://line.me/R/nv/location/",
            },
          },
        ],
      },
    },
  };
}

/** After save: optional nickname for family. */
export function buildSavedPlaceFlex(options: {
  displayName: string;
  address?: string;
  favoriteId: string;
}): FlexMessage {
  return {
    type: "flex",
    altText: `已存好 ${options.displayName}`,
    contents: {
      type: "bubble",
      size: "mega",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        paddingAll: "20px",
        contents: [
          {
            type: "text",
            text: "✅ 已存好這個地方",
            weight: "bold",
            size: "xl",
          },
          {
            type: "text",
            text: options.displayName,
            size: "lg",
            weight: "bold",
            color: "#059669",
            wrap: true,
            margin: "md",
          },
          ...(options.address
            ? [
                {
                  type: "text" as const,
                  text: options.address,
                  size: "sm" as const,
                  color: "#6b7280",
                  wrap: true,
                },
              ]
            : []),
          {
            type: "text",
            text: "長輩之後只要點「最愛」再點這裡即可。\n家人若要好記，可加暱稱（地址仍保留）。",
            size: "sm",
            color: "#4b5563",
            wrap: true,
            margin: "md",
          },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          {
            type: "button",
            style: "secondary",
            height: "md",
            action: {
              type: "message",
              label: "✏️ 加暱稱（選填）",
              text: `暱稱地點:${options.favoriteId}`,
            },
          },
        ],
      },
    },
  };
}

/** Pick which place gets a nickname. */
export function buildPickNicknameTargetFlex(
  favorites: Array<{
    id: string;
    label: string;
    nickname?: string;
    address?: string;
  }>
): FlexMessage {
  return {
    type: "flex",
    altText: "要幫哪個地方加暱稱？",
    contents: {
      type: "bubble",
      size: "mega",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        paddingAll: "20px",
        contents: [
          {
            type: "text",
            text: "幫哪個地方加暱稱？",
            weight: "bold",
            size: "xl",
          },
          {
            type: "text",
            text: "暱稱是備註；地址會一直顯示在下面。",
            size: "md",
            color: "#4b5563",
            wrap: true,
          },
          {
            type: "box",
            layout: "vertical",
            spacing: "md",
            margin: "lg",
            contents: favorites.map((f) => {
              const title = f.nickname?.trim() || f.label;
              const addr = f.address?.trim() || f.label;
              return {
                type: "box" as const,
                layout: "vertical" as const,
                spacing: "xs" as const,
                paddingAll: "10px" as const,
                backgroundColor: "#f0fdfa",
                cornerRadius: "md" as const,
                contents: [
                  {
                    type: "text" as const,
                    text: title,
                    weight: "bold" as const,
                    size: "md" as const,
                    wrap: true,
                  },
                  {
                    type: "text" as const,
                    text: `📍 ${addr}`,
                    size: "sm" as const,
                    color: "#4b5563",
                    wrap: true,
                  },
                  {
                    type: "button" as const,
                    style: "primary" as const,
                    color: "#0f766e",
                    height: "sm" as const,
                    margin: "sm" as const,
                    action: {
                      type: "message" as const,
                      label: "幫這裡加暱稱",
                      text: `暱稱地點:${f.id}`,
                    },
                  },
                ],
              };
            }),
          },
        ],
      },
    },
  };
}

export function buildAskNicknameTextMessage(
  placeLabel: string,
  address?: string
): TextMessage {
  return buildTextMessage(
    `請打上暱稱（家人可代打），例如：兒子家、診所\n` +
      `對象：${placeLabel}` +
      (address ? `\n地址：${address}` : "") +
      `\n\n直接傳文字即可；不想加就傳「不用了」。`
  );
}

/** Visual carousel of nearby clean points — easier for seniors than plain text. */
export function buildNearbyStopsFlex(guide: {
  radiusMeters: number;
  userLat: number;
  userLng: number;
  recommendReason: string;
  areaNextArrival?: string;
  recommend: {
    id: string;
    name: string;
    address: string;
    lat: number;
    lng: number;
    distanceMeters: number;
    scheduledTime: string | null;
    status: "live" | "upcoming" | "passed" | "no_service";
    statusLabel: string;
    etaMinutes?: number;
    nextArrival?: string;
  } | null;
  stops: Array<{
    id: string;
    name: string;
    address: string;
    lat: number;
    lng: number;
    distanceMeters: number;
    scheduledTime: string | null;
    status: "live" | "upcoming" | "passed" | "no_service";
    statusLabel: string;
    etaMinutes?: number;
    nextArrival?: string;
  }>;
}): Message {
  if (!guide.recommend || guide.stops.length === 0) {
    return withQuickReply(
      buildTextMessage(
        `⚠️ 方圓 ${guide.radiusMeters}m 找不到清運點。\n可傳「半徑 200」加大範圍。`
      )
    );
  }

  const statusStyle = (
    status: "live" | "upcoming" | "passed" | "no_service"
  ): { bg: string; emoji: string; label: string } => {
    switch (status) {
      case "live":
        return { bg: "#059669", emoji: "🟢", label: "車快到了" };
      case "upcoming":
        return { bg: "#2563eb", emoji: "🔵", label: "還能等" };
      case "passed":
        return { bg: "#9ca3af", emoji: "⚪", label: "已過站" };
      default:
        return { bg: "#dc2626", emoji: "🔴", label: "今日無班" };
    }
  };

  const buildMapUrl = (
    focus?: { lat: number; lng: number; name: string }
  ): string => {
    const params = new URLSearchParams();
    params.set("uLat", String(guide.userLat));
    params.set("uLng", String(guide.userLng));
    params.set("radius", String(guide.radiusMeters));
    if (focus) {
      params.set("sLat", String(focus.lat));
      params.set("sLng", String(focus.lng));
      params.set("stop", focus.name);
    } else if (guide.recommend) {
      params.set("sLat", String(guide.recommend.lat));
      params.set("sLng", String(guide.recommend.lng));
      params.set("stop", guide.recommend.name);
    }
    const near = guide.stops
      .slice(0, 8)
      .map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`)
      .join("|");
    if (near) params.set("near", near);
    return `https://ecotrack-hsinchu.vercel.app/map?${params.toString()}`;
  };

  /** Preview map image for seniors — see the pin, not only words. */
  const buildStaticMapImage = (lat: number, lng: number): string => {
    const params = new URLSearchParams({
      lat: lat.toFixed(6),
      lng: lng.toFixed(6),
      z: "16",
    });
    return `https://ecotrack-hsinchu.vercel.app/api/static-map?${params.toString()}`;
  };

  const overviewMap = buildMapUrl();
  const rec = guide.recommend;
  const recStyle = statusStyle(rec.status);

  const recommendBubble: messagingApi.FlexBubble = {
    type: "bubble",
    size: "mega",
    hero: {
      type: "image",
      url: buildStaticMapImage(rec.lat, rec.lng),
      size: "full",
      aspectRatio: "20:11",
      aspectMode: "cover",
      action: {
        type: "uri",
        label: "打開地圖",
        uri: overviewMap,
      },
    },
    header: {
      type: "box",
      layout: "vertical",
      paddingAll: "16px",
      backgroundColor: "#059669",
      contents: [
        {
          type: "text",
          text: "附近哪裡可以倒？",
          weight: "bold",
          size: "xl",
          color: "#ffffff",
          align: "center",
        },
        {
          type: "text",
          text: `方圓約 ${guide.radiusMeters} 公尺　點圖可開地圖`,
          size: "sm",
          color: "#d1fae5",
          align: "center",
          margin: "sm",
        },
      ],
    },
    body: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      paddingAll: "16px",
      contents: [
        {
          type: "box",
          layout: "vertical",
          paddingAll: "14px",
          backgroundColor: "#ecfdf5",
          cornerRadius: "lg",
          contents: [
            {
              type: "text",
              text: `${recStyle.emoji} 建議你去這裡`,
              weight: "bold",
              size: "lg",
              color: "#047857",
            },
            {
              type: "text",
              text: rec.name,
              weight: "bold",
              size: "xl",
              wrap: true,
              margin: "md",
            },
            {
              type: "text",
              text: `走路約 ${rec.distanceMeters} 公尺`,
              size: "lg",
              color: "#374151",
              margin: "md",
            },
            ...(rec.etaMinutes !== undefined
              ? [
                  {
                    type: "text" as const,
                    text: `預估約 ${rec.etaMinutes} 分後到（約 ${formatAbsoluteTime(rec.etaMinutes)}）`,
                    weight: "bold" as const,
                    size: "xl" as const,
                    color: "#059669",
                    wrap: true,
                    margin: "md" as const,
                  },
                  {
                    type: "text" as const,
                    text: `表定 ${rec.scheduledTime ?? "未知"}（僅供參考）`,
                    size: "sm" as const,
                    color: "#6b7280",
                    margin: "sm" as const,
                  },
                ]
              : [
                  {
                    type: "text" as const,
                    text: `表定 ${rec.scheduledTime ?? "未知"}`,
                    size: "lg" as const,
                    color: "#374151",
                    margin: "sm" as const,
                  },
                  {
                    type: "text" as const,
                    text:
                      rec.status === "upcoming" || rec.status === "live"
                        ? `${rec.statusLabel}\n（當日有訊號時會改顯示預估幾分後到）`
                        : rec.statusLabel,
                    size: "md" as const,
                    color: "#065f46",
                    wrap: true,
                    margin: "sm" as const,
                  },
                ]),
            ...(rec.etaMinutes !== undefined
              ? [
                  {
                    type: "text" as const,
                    text: rec.statusLabel,
                    size: "sm" as const,
                    color: "#047857",
                    wrap: true,
                    margin: "sm" as const,
                  },
                ]
              : []),
            ...(guide.areaNextArrival || rec.nextArrival
              ? [
                  {
                    type: "text" as const,
                    text: `附近下次最早：${guide.areaNextArrival || rec.nextArrival}`,
                    size: "md" as const,
                    color: "#b45309",
                    weight: "bold" as const,
                    wrap: true,
                    margin: "md" as const,
                  },
                ]
              : []),
            {
              type: "text",
              text: guide.recommendReason,
              size: "sm",
              color: "#6b7280",
              wrap: true,
              margin: "md",
            },
          ],
        },
        {
          type: "text",
          text: "當天有車訊號時會顯示「預估幾分後到」；沒訊號才只看表定。",
          size: "sm",
          color: "#6b7280",
          align: "center",
          margin: "md",
          wrap: true,
        },
      ],
    },
    footer: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: [
        {
          type: "button",
          style: "primary",
          color: "#059669",
          height: "md",
          action: {
            type: "uri",
            label: "打開大地圖",
            uri: overviewMap,
          },
        },
        {
          type: "button",
          style: "secondary",
          height: "md",
          action: {
            type: "message",
            label: "查即時垃圾車",
            text: "垃圾車",
          },
        },
      ],
    },
  };

  const stopBubbles: messagingApi.FlexBubble[] = guide.stops
    .slice(0, 5)
    .map((s, i) => {
      const style = statusStyle(s.status);
      const isRec = s.id === rec.id;
      const stopMap = buildMapUrl({ lat: s.lat, lng: s.lng, name: s.name });
      return {
        type: "bubble" as const,
        size: "mega" as const,
        hero: {
          type: "image" as const,
          url: buildStaticMapImage(s.lat, s.lng),
          size: "full" as const,
          aspectRatio: "20:11",
          aspectMode: "cover" as const,
          action: {
            type: "uri" as const,
            label: "打開地圖",
            uri: stopMap,
          },
        },
        header: {
          type: "box" as const,
          layout: "vertical" as const,
          paddingAll: "16px",
          backgroundColor: style.bg,
          contents: [
            {
              type: "text" as const,
              text: `${style.emoji} ${style.label}${isRec ? "　建議" : ""}`,
              color: "#ffffff",
              weight: "bold" as const,
              size: "lg" as const,
            },
            {
              type: "text" as const,
              text: `第 ${i + 1} 個　距離 ${s.distanceMeters}m`,
              color: "#ffffff",
              size: "md" as const,
              margin: "sm" as const,
            },
          ],
        },
        body: {
          type: "box" as const,
          layout: "vertical" as const,
          spacing: "sm" as const,
          paddingAll: "16px",
          contents: [
            {
              type: "text" as const,
              text: s.name,
              weight: "bold" as const,
              size: "xl" as const,
              wrap: true,
            },
            {
              type: "text" as const,
              text: s.address,
              size: "sm" as const,
              color: "#6b7280",
              wrap: true,
            },
            {
              type: "separator" as const,
              margin: "md" as const,
            },
            {
              type: "text" as const,
              text:
                s.etaMinutes !== undefined
                  ? `預估約 ${s.etaMinutes} 分後（約 ${formatAbsoluteTime(s.etaMinutes)}）`
                  : `表定 ${s.scheduledTime ?? "未知"}`,
              size: "md" as const,
              margin: "md" as const,
              color: s.etaMinutes !== undefined ? "#059669" : "#374151",
              ...(s.etaMinutes !== undefined
                ? { weight: "bold" as const }
                : {}),
            },
            ...(s.etaMinutes !== undefined
              ? [
                  {
                    type: "text" as const,
                    text: `表定 ${s.scheduledTime ?? "未知"}（參考）`,
                    size: "sm" as const,
                    color: "#6b7280",
                  },
                ]
              : []),
            {
              type: "text" as const,
              text: s.statusLabel,
              size: "md" as const,
              color: "#374151",
              wrap: true,
            },
            ...(s.nextArrival
              ? [
                  {
                    type: "text" as const,
                    text: `下次：${s.nextArrival}`,
                    size: "sm" as const,
                    color: "#6b7280",
                    wrap: true,
                    margin: "sm" as const,
                  },
                ]
              : []),
          ],
        },
        footer: {
          type: "box" as const,
          layout: "vertical" as const,
          contents: [
            {
              type: "button" as const,
              style: "primary" as const,
              color: style.bg,
              height: "md" as const,
              action: {
                type: "uri" as const,
                label: "看這個點在地圖哪",
                uri: stopMap,
              },
            },
          ],
        },
      };
    });

  return withQuickReply({
    type: "flex",
    altText: `附近清運點：建議去 ${rec.name}（${rec.distanceMeters}m）`,
    contents: {
      type: "carousel",
      contents: [recommendBubble, ...stopBubbles],
    },
  });
}

/** Delete picker — show nickname + address */
export function buildDeleteFavoriteFlex(
  favorites: Array<{ id: string; label: string; nickname?: string; address?: string }>
): FlexMessage {
  return {
    type: "flex",
    altText: "要刪哪一個地方？",
    contents: {
      type: "bubble",
      size: "mega",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        paddingAll: "20px",
        contents: [
          {
            type: "text",
            text: "要刪哪一個？",
            weight: "bold",
            size: "xl",
          },
          {
            type: "box",
            layout: "vertical",
            spacing: "md",
            margin: "lg",
            contents: favorites.map((f) => {
              const title = f.nickname?.trim() || f.label;
              const addr = f.address?.trim() || f.label;
              return {
                type: "box" as const,
                layout: "vertical" as const,
                spacing: "xs" as const,
                paddingAll: "10px" as const,
                backgroundColor: "#fef2f2",
                cornerRadius: "md" as const,
                contents: [
                  {
                    type: "text" as const,
                    text: title,
                    weight: "bold" as const,
                    size: "md" as const,
                    wrap: true,
                  },
                  {
                    type: "text" as const,
                    text: `📍 ${addr}`,
                    size: "sm" as const,
                    color: "#4b5563",
                    wrap: true,
                  },
                  {
                    type: "button" as const,
                    style: "primary" as const,
                    color: "#dc2626",
                    height: "sm" as const,
                    margin: "sm" as const,
                    action: {
                      type: "message" as const,
                      label: "刪除這裡",
                      text: `刪地點:${f.id}`,
                    },
                  },
                ],
              };
            }),
          },
        ],
      },
    },
  };
}

function formatAbsoluteTime(etaMinutes: number): string {
  const now = new Date();
  // Using Taiwan time (UTC+8) to safely format
  const targetTime = new Date(now.getTime() + etaMinutes * 60000 + (8 * 3600000));
  const h = targetTime.getUTCHours().toString().padStart(2, "0");
  const m = targetTime.getUTCMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
}
