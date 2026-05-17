/**
 * api/webhook.ts → Vercel Serverless Function: POST /api/webhook
 *
 * LINE Webhook endpoint (SDK v8):
 *  1. Validates x-line-signature (HMAC-SHA256 + timingSafeEqual)
 *  2. Handles location messages  → upsert user GPS, reply confirmation
 *  3. Handles text messages      → ETA query or help
 *  4. Handles follow events      → send welcome message
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import crypto from "crypto";
import type { webhook } from "@line/bot-sdk";
import { config } from "../src/config/index.js";
import { upsertUserLocation, getUserByLineId } from "../src/services/user.service.js";
import { calculateEta, syncTrucksFromHccg } from "../src/services/truck.service.js";
import {
  replyMessage,
  buildTextMessage,
  buildEtaMessages,
  buildLocationConfirmMessage,
  buildWelcomeMessage,
} from "../src/services/line.service.js";

// ── Type aliases from LINE SDK v8 webhook namespace ──────────
type Event            = webhook.Event;
type MessageEvent     = webhook.MessageEvent;
type FollowEvent      = webhook.FollowEvent;
type LocationMessageContent = webhook.LocationMessageContent;
type TextMessageContent     = webhook.TextMessageContent;

// ── Signature validation ─────────────────────────────────────

/**
 * Verifies x-line-signature using HMAC-SHA256 + timingSafeEqual.
 * Protects against spoofed webhook calls and timing attacks.
 */
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
  const sigBuffer  = Buffer.from(signature);

  if (hmacBuffer.length !== sigBuffer.length) return false;
  return crypto.timingSafeEqual(hmacBuffer, sigBuffer);
}

// ── Event handlers ────────────────────────────────────────────

async function handleLocationMessage(
  userId: string,
  replyToken: string,
  msg: LocationMessageContent
): Promise<void> {
  const { latitude, longitude, address } = msg;
  if (latitude == null || longitude == null) return;

  await upsertUserLocation(userId, latitude, longitude);
  await replyMessage(replyToken, [
    buildLocationConfirmMessage(address ?? "未知地址"),
  ]);
}

async function handleTextMessage(
  userId: string,
  replyToken: string,
  msg: TextMessageContent
): Promise<void> {
  const text = msg.text.trim();

  // ETA query keywords
  if (/垃圾車|在哪|幾點|到了|幾分|多久|ETA/i.test(text)) {
    const user = await getUserByLineId(userId);

    if (!user?.home_location) {
      await replyMessage(replyToken, [
        buildTextMessage(
          "⚠️ 您還沒有設定住家位置！\n\n" +
          "請點選 LINE 輸入框左側的「+」→「位置」，" +
          "傳送您的 GPS 位置後，我就能幫您追蹤附近的垃圾車 🗺️"
        ),
      ]);
      return;
    }

    // Get lat/lng stored in denormalized columns via RPC
    const { createClient } = await import("@supabase/supabase-js");
    const db = createClient(
      config.supabase.url,
      config.supabase.serviceRoleKey,
      { auth: { persistSession: false } }
    );

    const { data: coords } = await db.rpc("get_user_coords", {
      p_line_user_id: userId,
    });

    const coordData = coords as { lat: number; lng: number } | null;
    if (!coordData?.lat) {
      await replyMessage(replyToken, [
        buildTextMessage("⚠️ 無法讀取您的位置資料，請重新傳送 GPS 位置。"),
      ]);
      return;
    }

    // Force a fresh sync from HCCG API before calculating ETA to ensure real-time accuracy
    try {
      await syncTrucksFromHccg();
    } catch (e) {
      console.error("[Webhook] syncTrucksFromHccg error:", e);
      // We continue even if sync fails, calculateEta will use whatever is in Redis
    }

    const eta = await calculateEta(coordData.lat, coordData.lng);
    await replyMessage(replyToken, buildEtaMessages(eta));
    return;
  }

  // Help keywords
  if (/你好|hello|hi|幫助|help|怎麼用|使用/i.test(text)) {
    await replyMessage(replyToken, [buildWelcomeMessage()]);
    return;
  }

  // Default fallback
  await replyMessage(replyToken, [
    buildTextMessage(
      "🤔 我不太懂這個指令...\n\n" +
      "💡 試試看：\n" +
      "• 傳送「垃圾車在哪」→ 查詢 ETA\n" +
      "• 傳送 GPS 位置 → 綁定住家\n" +
      "• 傳送「幫助」→ 查看使用說明"
    ),
  ]);
}

async function handleFollowEvent(
  _userId: string,
  replyToken: string
): Promise<void> {
  await replyMessage(replyToken, [buildWelcomeMessage()]);
}

// ── Main Vercel handler ───────────────────────────────────────

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method Not Allowed" });
    return;
  }

  // Raw body for HMAC verification
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

  // Process all events concurrently; individual failures don't abort others
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
      }
    })
  );

  res.status(200).json({ status: "ok" });
}
