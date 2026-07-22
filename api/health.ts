import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabaseClient } from "../src/services/user.service.js";

/**
 * Lightweight liveness + Supabase keep-alive probe.
 * Returns 503 when the database is unreachable so monitors/CI fail loudly
 * instead of treating a dead DB as healthy.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  let dbStatus = "unknown";
  try {
    const db = getSupabaseClient();
    // A simple, fast query to ensure Supabase database activity
    const { error } = await db.from("users").select("id").limit(1);
    if (error) throw error;
    dbStatus = "connected";
  } catch (err: any) {
    dbStatus = `error: ${err.message || err}`;
  }

  const ok = dbStatus === "connected";
  res.status(ok ? 200 : 503).json({
    status: ok ? "alive" : "degraded",
    database: dbStatus,
    timestamp: new Date().toISOString(),
  });
}
