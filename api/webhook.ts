/**
 * api/webhook.ts → Vercel Serverless Function: POST /api/webhook
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import crypto from "crypto";
import type { webhook } from "@line/bot-sdk";
import { config } from "../src/config/index.js";
import { upsertUserLocation, getUserByLineId } from "../src/services/user.service.js";
import {
  calculateEta,
  getUserRouteId,
  setUserRouteId,
  resolveNearestRoute,
  searchCleanPointsByKeyword,
  getScheduleCardForLocation,
} from "../src/services/truck.service.js";
import {
  replyMessage,
  buildTextMessage,
  buildEtaMessages,
  buildLocationConfirmMessage,
  buildWelcomeMessage,
} from "../src/services/line.service.js";
import { classifyIntent, generateRagResponse } from "../src/services/rag.service.js";
import {
  getUserPrefs,
  setUserPrefs,
  upsertFavorite,
  clearActiveFavorite,
  clampRadiusMeters,
} from "../src/services/prefs.service.js";

type Event = webhook.Event;
type MessageEvent = webhook.MessageEvent;
type FollowEvent = webhook.FollowEvent;
type LocationMessageContent = webhook.LocationMessageContent;
type TextMessageContent = webhook.TextMessageContent;

function validateLineSignature(
  rawBody: string,
  signature: string | string[] | undefined
): boolean {
  if (!signature || Array.isArray(signature)) return false;

  const hmac = crypto
    .createHmac("SHA256", config.line.channelSecret)
    .update(rawBody)
    .digest("base64");

  const hmacBuffer = Buffer.from(hmac);
  const sigBuffer = Buffer.from(signature);

  if (hmacBuffer.length !== sigBuffer.length) return false;
  return crypto.timingSafeEqual(hmacBuffer, sigBuffer);
}

async function getActiveCoords(
  userId: string
): Promise<{ lat: number; lng: number; label: string } | null> {
  const prefs = await getUserPrefs(userId);
  if (prefs.activeFavoriteId) {
    const fav = prefs.favorites.find((f) => f.id === prefs.activeFavoriteId);
    if (fav) return { lat: fav.lat, lng: fav.lng, label: fav.label };
  }

  const { createClient } = await import("@supabase/supabase-js");
  const db = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
    auth: { persistSession: false },
  });
  const { data: coords } = await db.rpc("get_user_coords", {
    p_line_user_id: userId,
  });
  const coordData = coords as { lat: number; lng: number } | null;
  if (!coordData?.lat) return null;
  return { lat: coordData.lat, lng: coordData.lng, label: "住家" };
}

async function handleLocationMessage(
  userId: string,
  replyToken: string,
  msg: LocationMessageContent
): Promise<void> {
  const { latitude, longitude, address } = msg;
  if (latitude == null || longitude == null) return;

  await upsertUserLocation(userId, latitude, longitude);
  await clearActiveFavorite(userId);

  let routeSwitchNotice = "";
  try {
    const prefs = await getUserPrefs(userId);
    const [nearestRoute, prevRouteRaw] = await Promise.all([
      resolveNearestRoute(latitude, longitude, {
        locateMode: prefs.locateMode,
        radiusMeters: prefs.radiusMeters,
      }),
      getUserRouteId(userId),
    ]);

    if (nearestRoute) {
      const prevRoute = prevRouteRaw ? JSON.parse(prevRouteRaw) : null;
      if (prevRoute && prevRoute.routeId !== nearestRoute.routeId) {
        routeSwitchNotice =
          `\n\n🔄 路線已切換\n` +
          `原路線：${prevRoute.routeName}\n` +
          `新路線：${nearestRoute.routeName}\n` +
          `現在將追蹤新地址最近的垃圾車 🚛`;
      }
      await setUserRouteId(userId, nearestRoute.routeId, nearestRoute.routeName);
    }
  } catch (err) {
    console.error("[Webhook] Route switch detection failed:", err);
  }

  await replyMessage(replyToken, [
    buildLocationConfirmMessage(address ?? "未知地址", routeSwitchNotice),
  ]);
}

async function handleTextMessage(
  userId: string,
  replyToken: string,
  msg: TextMessageContent
): Promise<void> {
  const text = msg.text.trim();

  // Fast commands (beat official web forms — zero clicks)
  const radiusMatch = text.match(/^(?:半徑|range)\s*(\d{2,3})$/i);
  if (radiusMatch) {
    const radius = clampRadiusMeters(parseInt(radiusMatch[1], 10));
    const prefs = await setUserPrefs(userId, { radiusMeters: radius });
    await replyMessage(replyToken, [
      buildTextMessage(
        `✅ 搜尋半徑已設為 ${prefs.radiusMeters} 公尺\n` +
          `（官方可調 50–500，預設 100；我們一樣支援，且會記住你的設定）`
      ),
    ]);
    return;
  }

  const modeMatch = text.match(/^(?:模式|定位)\s*(推薦|整天|自動|全部)/);
  if (modeMatch) {
    const token = modeMatch[1];
    const locateMode =
      token === "整天" || token === "全部" ? "all_day" : "recommend";
    const prefs = await setUserPrefs(userId, { locateMode });
    await replyMessage(replyToken, [
      buildTextMessage(
        `✅ 定位模式：${
          prefs.locateMode === "recommend"
            ? "依目前時間推薦（對齊官方「自動」）"
            : "整天班表／距離優先（對齊官方「全部顯示」）"
        }\n` +
          `再傳「垃圾車」即可套用。`
      ),
    ]);
    return;
  }

  const favSave = text.match(/^(?:收藏|最愛)\s+(.+)$/);
  if (favSave) {
    const label = favSave[1].trim().slice(0, 20);
    // Prefer true home coords for new favorites
    const user = await getUserByLineId(userId);
    if (!user?.home_lat || !user?.home_lng) {
      await replyMessage(replyToken, [
        buildTextMessage("請先傳送 GPS 位置，再回覆「收藏 公司」。"),
      ]);
      return;
    }
    const prefs = await upsertFavorite(userId, {
      label,
      lat: user.home_lat,
      lng: user.home_lng,
      address: label,
    });
    await replyMessage(replyToken, [
      buildTextMessage(
        `⭐ 已收藏「${label}」並設為追蹤點（最多 3 個）\n` +
          `目前最愛：${prefs.favorites.map((f) => f.label).join("、")}\n` +
          `切換：切換 ${label}｜切換 住家｜最愛`
      ),
    ]);
    return;
  }

  if (/^最愛$/.test(text)) {
    const prefs = await getUserPrefs(userId);
    if (prefs.favorites.length === 0) {
      await replyMessage(replyToken, [
        buildTextMessage(
          "尚未收藏地點。傳送 GPS 後回覆「收藏 公司」即可（最多 3 個，優於官方單一我的最愛網頁流程）。"
        ),
      ]);
      return;
    }
    const active = prefs.activeFavoriteId
      ? prefs.favorites.find((f) => f.id === prefs.activeFavoriteId)?.label
      : "住家";
    await replyMessage(replyToken, [
      buildTextMessage(
        `⭐ 我的最愛\n` +
          prefs.favorites.map((f, i) => `${i + 1}. ${f.label}`).join("\n") +
          `\n目前追蹤：${active ?? "住家"}\n` +
          `指令：切換 公司｜切換 住家`
      ),
    ]);
    return;
  }

  const switchMatch = text.match(/^切換\s+(.+)$/);
  if (switchMatch) {
    const label = switchMatch[1].trim();
    if (label === "住家" || label === "家") {
      await clearActiveFavorite(userId);
      await replyMessage(replyToken, [
        buildTextMessage("✅ 已切回住家位置追蹤。傳「垃圾車」查看 ETA。"),
      ]);
      return;
    }
    const prefs = await getUserPrefs(userId);
    const fav = prefs.favorites.find((f) => f.label === label);
    if (!fav) {
      await replyMessage(replyToken, [
        buildTextMessage(`找不到最愛「${label}」。先傳「最愛」查看清單。`),
      ]);
      return;
    }
    await setUserPrefs(userId, { activeFavoriteId: fav.id });
    await replyMessage(replyToken, [
      buildTextMessage(`✅ 已切換追蹤「${fav.label}」。傳「垃圾車」或「班表」。`),
    ]);
    return;
  }

  const searchMatch = text.match(/^(?:查|搜尋|找)\s*(.+)$/);
  if (searchMatch) {
    const keyword = searchMatch[1].trim();
    const coords = await getActiveCoords(userId);
    const result = await searchCleanPointsByKeyword(
      keyword,
      coords?.lat,
      coords?.lng
    );
    await replyMessage(replyToken, [buildTextMessage(result)]);
    return;
  }

  if (/班表|時刻表|清運日/.test(text)) {
    const coords = await getActiveCoords(userId);
    if (!coords) {
      await replyMessage(replyToken, [
        buildTextMessage("請先傳送 GPS，或傳「查 路名」搜尋班表。"),
      ]);
      return;
    }
    const prefs = await getUserPrefs(userId);
    const card = await getScheduleCardForLocation(coords.lat, coords.lng, {
      locateMode: prefs.locateMode,
      radiusMeters: prefs.radiusMeters,
    });
    await replyMessage(replyToken, [buildTextMessage(card)]);
    return;
  }

  const intent = await classifyIntent(text);

  if (intent === "help") {
    await replyMessage(replyToken, [buildWelcomeMessage()]);
    return;
  }

  if (intent === "eta") {
    const coords = await getActiveCoords(userId);
    if (!coords) {
      await replyMessage(replyToken, [
        buildTextMessage(
          "⚠️ 您還沒有設定位置！\n\n" +
            "請點選「+」→「位置」傳送 GPS。\n" +
            "也可先「查 路名」搜尋班表。"
        ),
      ]);
      return;
    }

    const prefs = await getUserPrefs(userId);
    const eta = await calculateEta(coords.lat, coords.lng, {
      locateMode: prefs.locateMode,
      radiusMeters: prefs.radiusMeters,
    });
    const prefix =
      coords.label !== "住家"
        ? buildTextMessage(`📍 目前追蹤最愛：${coords.label}`)
        : null;
    const messages = buildEtaMessages(eta);
    await replyMessage(
      replyToken,
      prefix ? [prefix, ...messages] : messages
    );
    return;
  }

  if (intent === "rag") {
    const answer = await generateRagResponse(text);
    await replyMessage(replyToken, [buildTextMessage(answer)]);
    return;
  }

  await replyMessage(replyToken, [
    buildTextMessage(
      "🤔 可以這樣用（每項都比官方網頁快）：\n" +
        "• 垃圾車 → 即時 ETA＋推播\n" +
        "• 班表 → 整週清運日\n" +
        "• 查 中正路 → 關鍵字搜尋\n" +
        "• 半徑 200／模式 推薦｜整天\n" +
        "• 收藏 公司／切換 公司／最愛\n" +
        "• 傳送 GPS → 綁定住家"
    ),
  ]);
}

async function handleFollowEvent(
  _userId: string,
  replyToken: string
): Promise<void> {
  await replyMessage(replyToken, [buildWelcomeMessage()]);
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method Not Allowed" });
    return;
  }

  const rawBody =
    typeof req.body === "string" ? req.body : JSON.stringify(req.body);

  if (!validateLineSignature(rawBody, req.headers["x-line-signature"])) {
    console.warn("[Webhook] Rejected: invalid LINE signature");
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  let events: Event[];
  try {
    const parsed =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    events = (parsed as { events: Event[] }).events ?? [];
  } catch {
    res.status(400).json({ error: "Invalid JSON body" });
    return;
  }

  await Promise.allSettled(
    events.map(async (event: Event) => {
      try {
        const userId = event.source?.userId;
        if (!userId) return;

        if (event.type === "follow") {
          const fe = event as FollowEvent;
          if (!fe.replyToken) return;
          await handleFollowEvent(userId, fe.replyToken);
          return;
        }

        if (event.type === "message") {
          const me = event as MessageEvent;
          const { message } = me;
          const replyToken = me.replyToken;
          if (!replyToken) return;

          if (message.type === "location") {
            await handleLocationMessage(
              userId,
              replyToken,
              message as LocationMessageContent
            );
          } else if (message.type === "text") {
            await handleTextMessage(
              userId,
              replyToken,
              message as TextMessageContent
            );
          }
        }
      } catch (err) {
        console.error("[Webhook] Handler error:", err);
        try {
          const replyToken =
            event.type === "follow"
              ? (event as FollowEvent).replyToken
              : event.type === "message"
                ? (event as MessageEvent).replyToken
                : undefined;
          if (replyToken) {
            await replyMessage(replyToken, [
              buildTextMessage(
                "⚠️ 系統暫時無法完成這次查詢（可能是資料庫或即時訊號異常）。\n" +
                  "請稍後再試一次；若持續發生，多半是後端連線問題，我們會盡快恢復。"
              ),
            ]);
          }
        } catch (replyErr) {
          console.error("[Webhook] Failed to send error reply:", replyErr);
        }
      }
    })
  );

  res.status(200).json({ status: "ok" });
}
