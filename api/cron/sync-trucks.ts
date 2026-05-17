/**
 * api/cron/sync-trucks.ts → Vercel Serverless Function: GET /api/cron/sync-trucks
 *
 * Scheduled job (every 5 min via Vercel Cron):
 *  1. Fetches all vehicle GPS from HCCG API
 *  2. Filters to Xiangshan district routes
 *  3. Validates coordinates (no 0,0; Taiwan bounds; no teleport)
 *  4. Writes clean data to Upstash Redis with 300s TTL
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { syncTrucksFromHccg } from "../../src/services/truck.service.js";

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  // Protect from unauthorized manual triggers in production
  // Vercel Cron sends a special header; check the Authorization header
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const startTime = Date.now();

  try {
    console.log("[CronJob] Starting truck GPS sync from HCCG API...");

    const result = await syncTrucksFromHccg();

    const elapsed = Date.now() - startTime;

    console.log(
      `[CronJob] Sync complete in ${elapsed}ms: ` +
        `processed=${result.processed}, skipped=${result.skipped}, ` +
        `errors=${result.errors.length}`
    );

    if (result.errors.length > 0) {
      console.warn("[CronJob] Errors during sync:", result.errors);
    }

    res.status(200).json({
      status: "success",
      timestamp: new Date().toISOString(),
      elapsed_ms: elapsed,
      processed: result.processed,
      skipped: result.skipped,
      errors: result.errors,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[CronJob] Fatal sync error:", err);

    res.status(500).json({
      status: "error",
      timestamp: new Date().toISOString(),
      elapsed_ms: Date.now() - startTime,
      message: msg,
    });
  }
}
