/**
 * api/cron/notify-approaching.ts
 *
 * Pushes a one-shot LINE reminder when a user's garbage truck ETA is ≤ 5 minutes.
 * Deduped per user/route/day via Redis so we don't spam.
 *
 * Triggered by GitHub Actions every 10 minutes (Hobby-friendly) with CRON_SECRET.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Redis } from "@upstash/redis";
import { config } from "../../src/config/index.js";
import { listUsersForNotify } from "../../src/services/user.service.js";
import { calculateEta } from "../../src/services/truck.service.js";
import { pushMessage, buildTextMessage } from "../../src/services/line.service.js";

const APPROACHING_MINUTES = 5;
const NOTIFY_KEY = (userId: string, routeId: string, dayKey: string) =>
  `notify_sent:${userId}:${routeId}:${dayKey}`;

function getTaiwanDayKey(): string {
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const redis = new Redis({
    url: config.redis.restUrl,
    token: config.redis.restToken,
  });

  const dayKey = getTaiwanDayKey();
  const started = Date.now();
  let checked = 0;
  let notified = 0;
  let skipped = 0;
  const errors: string[] = [];

  try {
    const users = await listUsersForNotify(80);

    for (const user of users) {
      checked++;
      try {
        const eta = await calculateEta(user.home_lat, user.home_lng);
        const etaMinutes = eta.etaMinutes;
        if (
          etaMinutes === undefined ||
          etaMinutes < 0 ||
          etaMinutes > APPROACHING_MINUTES ||
          !eta.routeId
        ) {
          skipped++;
          continue;
        }

        const dedupeKey = NOTIFY_KEY(user.line_user_id, eta.routeId, dayKey);
        const already = await redis.get(dedupeKey);
        if (already) {
          skipped++;
          continue;
        }

        const stopLabel =
          eta.nearestStopName || eta.nearestStopAddress || "您的清運點";
        await pushMessage(user.line_user_id, [
          buildTextMessage(
            `🚛 垃圾車快到了！\n` +
              `📍 ${stopLabel}\n` +
              `⏱️ 預估約 ${etaMinutes} 分鐘內抵達` +
              (eta.carNo ? `\n🔢 車牌 ${eta.carNo}` : "") +
              `\n\n請準備出門倒垃圾 ♻️`
          ),
        ]);

        // Keep until end of Taiwan day (+ buffer)
        await redis.set(dedupeKey, "1", { ex: 60 * 60 * 36 });
        notified++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${user.line_user_id}: ${msg}`);
      }
    }

    res.status(200).json({
      status: "success",
      checked,
      notified,
      skipped,
      errors,
      elapsed_ms: Date.now() - started,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[NotifyCron] Fatal error:", err);
    res.status(500).json({
      status: "error",
      message: msg,
      elapsed_ms: Date.now() - started,
    });
  }
}
