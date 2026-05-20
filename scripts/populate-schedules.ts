import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";

config();

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const HCCG_API_BASE_URL = process.env.HCCG_API_BASE_URL || "https://7966.hccg.gov.tw/WEB/_IMP/API/CleanWeb";

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function main() {
  console.log("Fetching points from HCCG API...");
  const url = `${HCCG_API_BASE_URL}/getPointData?address=`;
  const response = await fetch(url, {
    headers: {
      Referer: "https://7966.hccg.gov.tw/WEB/App/route.html",
      "User-Agent": "EcoTrack-Bot/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`HCCG API failed: ${response.status}`);
  }

  const json = await response.json() as any;
  if (json.statusCode !== 1 || !json.data) {
    throw new Error(`HCCG API error: ${json.message}`);
  }

  const points = json.data.cleanPoint;
  console.log(`Fetched ${points.length} points from API.`);

  // Only update Xiangshan district (district = "3")
  const xiangshanPoints = points.filter((p: any) => p.district === "3");
  console.log(`Found ${xiangshanPoints.length} Xiangshan points.`);

  let updatedCount = 0;
  for (const p of xiangshanPoints) {
    const { routeId, seq, trashDay, recycleDay } = p;
    
    // Update Supabase route_stops table
    const { error } = await db
      .from("route_stops")
      .update({
        trash_day: trashDay,
        recycle_day: recycleDay,
      })
      .eq("route_id", routeId)
      .eq("sequence_order", parseInt(seq, 10));

    if (error) {
      console.error(`Failed to update route ${routeId} seq ${seq}:`, error.message);
    } else {
      updatedCount++;
    }
  }

  console.log(`Successfully updated ${updatedCount} stops in the database!`);
}

main().catch(console.error);
