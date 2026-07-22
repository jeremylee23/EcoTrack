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
  buildAskSendLocationFlex,
  buildDeleteFavoriteFlex,
  buildSavedPlaceFlex,
  buildPickNicknameTargetFlex,
  buildAskNicknameTextMessage,
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
  removeFavoriteById,
  setPendingAddFavorite,
  setPendingNickname,
  consumePendingAction,
  peekPendingAction,
  setFavoriteNickname,
  shortenAddress,
  favoriteDisplayName,
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

async function replyFavoritesMenu(
  userId: string,
  replyToken: string,
  extra?: Parameters<typeof replyMessage>[1][number]
): Promise<void> {
  const prefs = await getUserPrefs(userId);
  const active = prefs.activeFavoriteId
    ? prefs.favorites.find((f) => f.id === prefs.activeFavoriteId)
    : null;
  const menu = withQuickReply(
    buildFavoritesMenuFlex({
      favorites: prefs.favorites,
      activeLabel: active ? favoriteDisplayName(active) : "住家",
      activeId: prefs.activeFavoriteId,
    })
  );
  await replyMessage(replyToken, extra ? [extra, menu] : [menu]);
}

async function handleLocationMessage(
  userId: string,
  replyToken: string,
  msg: LocationMessageContent
): Promise<void> {
  const { latitude, longitude, address } = msg;
  if (latitude == null || longitude == null) return;

  // Add-place flow: save by address, do NOT overwrite home.
  const pending = await consumePendingAction(userId);
  if (pending?.type === "add") {
    const fullAddress = address?.trim() || "地圖上的位置";
    const label = shortenAddress(fullAddress);
    const prefsAfter = await upsertFavorite(userId, {
      label,
      lat: latitude,
      lng: longitude,
      address: fullAddress,
    });
    const saved = prefsAfter.favorites[0];

    try {
      const nearestRoute = await resolveNearestRoute(latitude, longitude, {
        locateMode: prefsAfter.locateMode,
        radiusMeters: prefsAfter.radiusMeters,
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

    const coords = await getActiveCoords(userId);
    const eta = coords
      ? await calculateEta(coords.lat, coords.lng, {
          locateMode: prefsAfter.locateMode,
          radiusMeters: prefsAfter.radiusMeters,
        })
      : null;

    const messages = [
      buildSavedPlaceFlex({
        displayName: saved ? favoriteDisplayName(saved) : label,
        address: fullAddress,
        favoriteId: saved?.id ?? "",
      }),
      ...(eta ? buildEtaMessages(eta) : []),
    ];
    await replyMessage(replyToken, attachQuickReplyToLast(messages));
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
        routeSwitchNotice = `\n\n路線已換成：${nearestRoute.routeName}`;
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

  // If family is typing a nickname, capture free text first.
  const nicknamePending = await peekPendingAction(userId);
  if (nicknamePending?.type === "nickname") {
    if (/^(不用了|取消|算了)$/.test(text)) {
      await consumePendingAction(userId);
      await replyFavoritesMenu(
        userId,
        replyToken,
        withQuickReply(buildTextMessage("好，不加暱稱也可以。"))
      );
      return;
    }
    // Don't steal real commands
    if (
      !/^(說明|幫助|搜尋|設定|最愛|新增地點|加暱稱|刪除地點|垃圾車|班表)/.test(
        text
      ) &&
      !text.startsWith("用") &&
      !text.startsWith("查 ") &&
      !text.includes(":")
    ) {
      await consumePendingAction(userId);
      const updated = await setFavoriteNickname(
        userId,
        nicknamePending.favoriteId,
        text
      );
      if (!updated) {
        await replyMessage(replyToken, [
          withQuickReply(buildTextMessage("找不到這個地方，請再從「最愛」操作一次。")),
        ]);
        return;
      }
      const spot = updated.favorites.find(
        (f) => f.id === nicknamePending.favoriteId
      );
      await replyFavoritesMenu(
        userId,
        replyToken,
        withQuickReply(
          buildTextMessage(
            `✅ 已加上暱稱「${text.trim().slice(0, 12)}」\n` +
              `地址仍是：${spot?.address || spot?.label || ""}`
          )
        )
      );
      return;
    }
  }

  const favSave = text.match(/^(?:收藏|最愛)\s+(.+)$/);
  if (favSave) {
    await replyFavoritesMenu(
      userId,
      replyToken,
      withQuickReply(
        buildTextMessage("不用這樣打字。請用下面大按鈕操作即可。")
      )
    );
    return;
  }

  // ── Favorites (address + optional nickname) ────────────────
  if (/^最愛$/.test(text)) {
    await replyFavoritesMenu(userId, replyToken);
    return;
  }

  if (/^新增地點$/.test(text)) {
    await setPendingAddFavorite(userId);
    await replyMessage(replyToken, [buildAskSendLocationFlex("add")]);
    return;
  }

  if (/^加暱稱$/.test(text)) {
    const prefs = await getUserPrefs(userId);
    if (prefs.favorites.length === 0) {
      await replyMessage(replyToken, [
        withQuickReply(buildTextMessage("還沒有其他地方。請先「新增地方」。")),
      ]);
      return;
    }
    await replyMessage(replyToken, [
      buildPickNicknameTargetFlex(prefs.favorites),
    ]);
    return;
  }

  const nickTarget = text.match(/^暱稱地點:(.+)$/);
  if (nickTarget) {
    const favoriteId = nickTarget[1].trim();
    const prefs = await getUserPrefs(userId);
    const spot = prefs.favorites.find((f) => f.id === favoriteId);
    if (!spot) {
      await replyMessage(replyToken, [
        withQuickReply(buildTextMessage("找不到這個地方，請再試一次。")),
      ]);
      return;
    }
    await setPendingNickname(userId, favoriteId);
    await replyMessage(replyToken, [
      buildAskNicknameTextMessage(favoriteDisplayName(spot)),
    ]);
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

  const deleteById = text.match(/^刪地點:(.+)$/);
  if (deleteById) {
    await removeFavoriteById(userId, deleteById[1].trim());
    await replyFavoritesMenu(
      userId,
      replyToken,
      withQuickReply(buildTextMessage("✅ 已刪除"))
    );
    return;
  }

  // Legacy delete by display name
  const deleteMatch = text.match(/^刪除(.+)$/);
  if (deleteMatch && deleteMatch[1].trim() !== "地點") {
    const label = deleteMatch[1].trim();
    const prefs = await getUserPrefs(userId);
    const spot = prefs.favorites.find(
      (f) =>
        f.label === label ||
        f.nickname === label ||
        favoriteDisplayName(f) === label
    );
    if (spot) await removeFavoriteById(userId, spot.id);
    await replyFavoritesMenu(
      userId,
      replyToken,
      withQuickReply(buildTextMessage(`✅ 已刪除「${label}」`))
    );
    return;
  }

  if (/^用住家$/.test(text) || /^用家$/.test(text)) {
    await clearActiveFavorite(userId);
    await replyEtaNow(userId, replyToken, "✅ 已換成「住家」");
    return;
  }

  const useById = text.match(/^用地點:(.+)$/);
  if (useById) {
    const favId = useById[1].trim();
    const prefs = await getUserPrefs(userId);
    const fav = prefs.favorites.find((f) => f.id === favId);
    if (!fav) {
      await replyFavoritesMenu(
        userId,
        replyToken,
        withQuickReply(buildTextMessage("找不到這個地方，請重新選一次。"))
      );
      return;
    }
    await setUserPrefs(userId, { activeFavoriteId: fav.id });
    await replyEtaNow(
      userId,
      replyToken,
      `✅ 已換成「${favoriteDisplayName(fav)}」`
    );
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
    const fav = prefs.favorites.find(
      (f) =>
        f.label === label ||
        f.nickname === label ||
        favoriteDisplayName(f) === label
    );
    if (!fav) {
      await replyFavoritesMenu(
        userId,
        replyToken,
        withQuickReply(
          buildTextMessage(`還沒有「${label}」。請先「新增地方」傳位置。`)
        )
      );
      return;
    }
    await setUserPrefs(userId, { activeFavoriteId: fav.id });
    await replyEtaNow(
      userId,
      replyToken,
      `✅ 已換成「${favoriteDisplayName(fav)}」`
    );
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
    const fav = prefs.favorites.find(
      (f) =>
        f.label === label ||
        f.nickname === label ||
        favoriteDisplayName(f) === label
    );
    if (!fav) {
      await replyFavoritesMenu(userId, replyToken);
      return;
    }
    await setUserPrefs(userId, { activeFavoriteId: fav.id });
    await replyEtaNow(
      userId,
      replyToken,
      `✅ 已換成「${favoriteDisplayName(fav)}」`
    );
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
        withQuickReply(buildTextMessage("請先點選單「定位」傳住家位置。")),
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
