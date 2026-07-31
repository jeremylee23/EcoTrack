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
import {
  ensureCronAuthorized,
  sendError,
  sendJson,
} from "../../src/utils/api-handler.util.js";

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  if (!ensureCronAuthorized(req, res)) return;

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

    sendJson(res, 200, {
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

    sendError(res, 500, "SYNC_TRUCKS_FAILED", msg, {
      elapsed_ms: Date.now() - startTime,
    });
  }
}
