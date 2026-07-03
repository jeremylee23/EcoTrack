import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabaseClient } from "../src/services/user.service.js";

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

  res.status(200).json({
    status: "alive",
    database: dbStatus,
    timestamp: new Date().toISOString()
  });
}

