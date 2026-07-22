/**
 * api/webhook.ts → Vercel Serverless Function: POST /api/webhook
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import crypto from "crypto";
import type { webhook } from "@line/bot-sdk";
import { config } from "../src/config/index.js";
import {
  upsertUserLocation,
  setNotifyEnabled,
} from "../src/services/user.service.js";
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
  buildFavoritesMenuFlex,
  buildPickFavoriteNameFlex,
  buildAskSendLocationFlex,
  buildDeleteFavoriteFlex,
  withQuickReply,
  attachQuickReplyToLast,
} from "../src/services/line.service.js";
import { classifyIntent, generateRagResponse } from "../src/services/rag.service.js";
import {
  getUserPrefs,
  setUserPrefs,
  upsertFavorite,
  clearActiveFavorite,
  clampRadiusMeters,
  removeFavoriteByLabel,
  setPendingFavoriteLabel,
  consumePendingFavoriteLabel,
  isFavoritePreset,
  FAVORITE_PRESETS,
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

async function replyEtaNow(
  userId: string,
  replyToken: string,
  notice?: string
): Promise<void> {
  const coords = await getActiveCoords(userId);
  if (!coords) {
    await replyMessage(replyToken, [
      withQuickReply(
        buildTextMessage(
          "還沒設定位置。\n請先點底部選單「📍 定位」，傳一次住家位置。"
        )
      ),
    ]);
    return;
  }

  const prefs = await getUserPrefs(userId);
  const eta = await calculateEta(coords.lat, coords.lng, {
    locateMode: prefs.locateMode,
    radiusMeters: prefs.radiusMeters,
  });
  const prefixParts: string[] = [];
  if (notice) prefixParts.push(notice);
  if (coords.label !== "住家") {
    prefixParts.push(`📍 現在查的是：${coords.label}`);
  }
  const prefix =
    prefixParts.length > 0
      ? buildTextMessage(prefixParts.join("\n"))
      : null;
  const messages = buildEtaMessages(eta);
  await replyMessage(
    replyToken,
    attachQuickReplyToLast(prefix ? [prefix, ...messages] : messages)
  );
}

async function handleLocationMessage(
  userId: string,
  replyToken: string,
  msg: LocationMessageContent
): Promise<void> {
  const { latitude, longitude, address } = msg;
  if (latitude == null || longitude == null) return;

  // Senior add-place flow: save as named favorite WITHOUT overwriting home.
  const pendingLabel = await consumePendingFavoriteLabel(userId);
  if (pendingLabel) {
    await upsertFavorite(userId, {
      label: pendingLabel,
      lat: latitude,
      lng: longitude,
      address: address ?? pendingLabel,
    });

    try {
      const prefs = await getUserPrefs(userId);
      const nearestRoute = await resolveNearestRoute(latitude, longitude, {
        locateMode: prefs.locateMode,
        radiusMeters: prefs.radiusMeters,
      });
      if (nearestRoute) {
        await setUserRouteId(
          userId,
          nearestRoute.routeId,
          nearestRoute.routeName
        );
      }
    } catch (err) {
      console.error("[Webhook] Favorite route bind failed:", err);
    }

    await replyEtaNow(
      userId,
      replyToken,
      `✅ 已存好「${pendingLabel}」，並立刻幫您查車`
    );
    return;
  }

  // Default: treat as home location
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
          `\n\n路線已換成：${nearestRoute.routeName}`;
      }
      await setUserRouteId(userId, nearestRoute.routeId, nearestRoute.routeName);
    }
  } catch (err) {
    console.error("[Webhook] Route switch detection failed:", err);
  }

  await replyMessage(replyToken, [
    buildLocationConfirmMessage(address ?? "這個位置", routeSwitchNotice),
  ]);
}

async function handleTextMessage(
  userId: string,
  replyToken: string,
  msg: TextMessageContent
): Promise<void> {
  const text = msg.text.trim();

  // Menu aliases + help (Rich Menu / Quick Reply)
  if (/^(說明|幫助|怎麼用|使用說明|help)$/i.test(text)) {
    await replyMessage(replyToken, [buildWelcomeMessage()]);
    return;
  }

  if (/^搜尋$/.test(text)) {
    await replyMessage(replyToken, [
      withQuickReply(
        buildTextMessage(
          `🔍 關鍵字搜尋（對齊官方搜尋框，更快）\n\n` +
            `請回覆：查 路名或地標\n` +
            `例如：\n` +
            `• 查 中正路\n` +
            `• 查 東門\n` +
            `• 查 香山`
        )
      ),
    ]);
    return;
  }

  if (/^設定$/.test(text)) {
    const prefs = await getUserPrefs(userId);
    await replyMessage(replyToken, [
      withQuickReply(
        buildTextMessage(
          `⚙️ 目前設定\n` +
            `• 模式：${prefs.locateMode === "recommend" ? "依時間推薦" : "整天班表"}\n` +
            `• 半徑：${prefs.radiusMeters}m\n` +
            `• 最愛：${prefs.favorites.length} 個` +
            (prefs.activeFavoriteId
              ? `（追蹤中：${
                  prefs.favorites.find((f) => f.id === prefs.activeFavoriteId)
                    ?.label ?? "?"
                }）`
              : "（追蹤住家）") +
            `\n\n可改：\n` +
            `• 模式 推薦｜模式 整天\n` +
            `• 半徑 100｜半徑 200｜半徑 500\n` +
            `• 通知 開｜通知 關`
        )
      ),
    ]);
    return;
  }

  const notifyMatch = text.match(/^通知\s*(開|關|on|off)$/i);
  if (notifyMatch) {
    const enabled = /開|on/i.test(notifyMatch[1]);
    try {
      await setNotifyEnabled(userId, enabled);
      await replyMessage(replyToken, [
        withQuickReply(
          buildTextMessage(
            enabled
              ? "✅ 已開啟靠近推播（約 5 分鐘會提醒）"
              : "✅ 已關閉靠近推播（仍可手動查垃圾車）"
          )
        ),
      ]);
    } catch (err) {
      console.error("[Webhook] setNotifyEnabled failed:", err);
      await replyMessage(replyToken, [
        withQuickReply(
          buildTextMessage("⚠️ 通知設定暫時無法更新，請稍後再試。")
        ),
      ]);
    }
    return;
  }

  // Fast commands (beat official web forms — zero clicks)
  const radiusMatch = text.match(/^(?:半徑|range)\s*(\d{2,3})$/i);
  if (radiusMatch) {
    const radius = clampRadiusMeters(parseInt(radiusMatch[1], 10));
    const prefs = await setUserPrefs(userId, { radiusMeters: radius });
    await replyMessage(replyToken, [
      withQuickReply(
        buildTextMessage(
          `✅ 搜尋半徑已設為 ${prefs.radiusMeters} 公尺\n` +
            `（官方可調 50–500，預設 100；我們會記住你的設定）`
        )
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
      withQuickReply(
        buildTextMessage(
          `✅ 定位模式：${
            prefs.locateMode === "recommend"
              ? "依目前時間推薦（對齊官方「自動」）"
              : "整天班表／距離優先（對齊官方「全部顯示」）"
          }\n` +
            `再點選單「垃圾車」即可套用。`
        )
      ),
    ]);
    return;
  }

  const favSave = text.match(/^(?:收藏|最愛)\s+(.+)$/);
  if (favSave) {
    // Legacy typed command → redirect to button flow (elderly-friendly)
    await replyMessage(replyToken, [
      withQuickReply(
        buildTextMessage("不用打字喔！請點選單「⭐ 最愛」，再用大按鈕操作。")
      ),
      buildFavoritesMenuFlex({
        favorites: (await getUserPrefs(userId)).favorites,
        activeLabel: "住家",
      }),
    ]);
    return;
  }

  // ── Elderly one-tap favorites ──────────────────────────────
  if (/^最愛$/.test(text)) {
    const prefs = await getUserPrefs(userId);
    const activeLabel = prefs.activeFavoriteId
      ? prefs.favorites.find((f) => f.id === prefs.activeFavoriteId)?.label ??
        "住家"
      : "住家";
    await replyMessage(replyToken, [
      withQuickReply(
        buildFavoritesMenuFlex({
          favorites: prefs.favorites,
          activeLabel,
        })
      ),
    ]);
    return;
  }

  if (/^新增地點$/.test(text)) {
    await replyMessage(replyToken, [buildPickFavoriteNameFlex()]);
    return;
  }

  const saveNameMatch = text.match(/^要存(.+)$/);
  if (saveNameMatch) {
    const label = saveNameMatch[1].trim();
    if (!isFavoritePreset(label)) {
      await replyMessage(replyToken, [
        withQuickReply(
          buildTextMessage(
            `請點大按鈕選名稱：${FAVORITE_PRESETS.join("、")}`
          )
        ),
        buildPickFavoriteNameFlex(),
      ]);
      return;
    }
    await setPendingFavoriteLabel(userId, label);
    await replyMessage(replyToken, [buildAskSendLocationFlex(label)]);
    return;
  }

  if (/^刪除地點$/.test(text)) {
    const prefs = await getUserPrefs(userId);
    if (prefs.favorites.length === 0) {
      await replyMessage(replyToken, [
        withQuickReply(buildTextMessage("目前沒有其他地方可以刪。")),
      ]);
      return;
    }
    await replyMessage(replyToken, [
      buildDeleteFavoriteFlex(prefs.favorites),
    ]);
    return;
  }

  const deleteMatch = text.match(/^刪除(.+)$/);
  if (deleteMatch && deleteMatch[1].trim() !== "地點") {
    const label = deleteMatch[1].trim();
    await removeFavoriteByLabel(userId, label);
    const prefs = await getUserPrefs(userId);
    await replyMessage(replyToken, [
      withQuickReply(buildTextMessage(`✅ 已刪除「${label}」`)),
      buildFavoritesMenuFlex({
        favorites: prefs.favorites,
        activeLabel: "住家",
      }),
    ]);
    return;
  }

  const usePlaceMatch = text.match(/^用(.+)$/);
  if (usePlaceMatch) {
    const label = usePlaceMatch[1].trim();
    if (label === "住家" || label === "家") {
      await clearActiveFavorite(userId);
      await replyEtaNow(userId, replyToken, "✅ 已換成「住家」");
      return;
    }
    const prefs = await getUserPrefs(userId);
    const fav = prefs.favorites.find((f) => f.label === label);
    if (!fav) {
      await replyMessage(replyToken, [
        withQuickReply(
          buildTextMessage(
            `還沒存「${label}」。\n請點「➕ 新增一個地方」，再傳位置。`
          )
        ),
        buildPickFavoriteNameFlex(),
      ]);
      return;
    }
    await setUserPrefs(userId, { activeFavoriteId: fav.id });
    await replyEtaNow(userId, replyToken, `✅ 已換成「${fav.label}」`);
    return;
  }

  const switchMatch = text.match(/^切換\s+(.+)$/);
  if (switchMatch) {
    const label = switchMatch[1].trim();
    if (label === "住家" || label === "家") {
      await clearActiveFavorite(userId);
      await replyEtaNow(userId, replyToken, "✅ 已換成「住家」");
      return;
    }
    const prefs = await getUserPrefs(userId);
    const fav = prefs.favorites.find((f) => f.label === label);
    if (!fav) {
      await replyMessage(replyToken, [
        withQuickReply(
          buildTextMessage(`找不到「${label}」。請點選單「最愛」用大按鈕操作。`)
        ),
      ]);
      return;
    }
    await setUserPrefs(userId, { activeFavoriteId: fav.id });
    await replyEtaNow(userId, replyToken, `✅ 已換成「${fav.label}」`);
    return;
  }

  const searchMatch = text.match(/^(?:查|搜尋|找)\s+(.+)$/);
  if (searchMatch) {
    const keyword = searchMatch[1].trim();
    const coords = await getActiveCoords(userId);
    const result = await searchCleanPointsByKeyword(
      keyword,
      coords?.lat,
      coords?.lng
    );
    await replyMessage(replyToken, [withQuickReply(buildTextMessage(result))]);
    return;
  }

  if (/班表|時刻表|清運日/.test(text)) {
    const coords = await getActiveCoords(userId);
    if (!coords) {
      await replyMessage(replyToken, [
        withQuickReply(
          buildTextMessage("請先點選單「定位」傳住家位置。")
        ),
      ]);
      return;
    }
    const prefs = await getUserPrefs(userId);
    const card = await getScheduleCardForLocation(coords.lat, coords.lng, {
      locateMode: prefs.locateMode,
      radiusMeters: prefs.radiusMeters,
    });
    await replyMessage(replyToken, [withQuickReply(buildTextMessage(card))]);
    return;
  }

  const intent = await classifyIntent(text);

  if (intent === "help") {
    await replyMessage(replyToken, [buildWelcomeMessage()]);
    return;
  }

  if (intent === "eta") {
    await replyEtaNow(userId, replyToken);
    return;
  }

  if (intent === "rag") {
    const answer = await generateRagResponse(text);
    await replyMessage(replyToken, [withQuickReply(buildTextMessage(answer))]);
    return;
  }

  await replyMessage(replyToken, [buildWelcomeMessage()]);
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
