import { createClient } from "@supabase/supabase-js";
import { config as dotenvConfig } from "dotenv";

dotenvConfig();

async function fetchAllStops() {
  console.log("Fetching all districts data from HCCG...");
  const url = "https://7966.hccg.gov.tw/WEB/_IMP/API/CleanWeb/getPointData?address=";
  const response = await fetch(url, {
    headers: {
      Referer: "https://7966.hccg.gov.tw/WEB/cleanPoint.html",
      "User-Agent": "EcoTrack-Bot/1.0",
    },
  });
  const json: any = await response.json();
  return json.data.cleanPoint;
}

async function run() {
  const points = await fetchAllStops();
  console.log(`Fetched ${points.length} points.`);

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  try {
    const routesMap = new Map();
    for (const p of points) {
      if (!routesMap.has(p.routeId)) {
        routesMap.set(p.routeId, {
          id: p.routeId,
          name: p.routeName,
          type: "general",
        });
      }
    }

    console.log(`Found ${routesMap.size} unique routes. Inserting...`);

    const routesArray = Array.from(routesMap.values());
    const { error: routeError } = await supabase.from('truck_routes').upsert(routesArray);
    if (routeError) throw routeError;

    console.log("Inserting route stops...");
    
    // TRUNCATE is not possible via REST API directly without RPC, 
    // but we can just use delete all for route_stops
    console.log("Deleting old stops...");
    await supabase.from('route_stops').delete().neq('id', '00000000-0000-0000-0000-000000000000');

    let count = 0;
    
    // Batch insert points
    const batchSize = 1000;
    const allStopsToInsert = [];
    
    for (const p of points) {
      const lat = parseFloat(p.lat);
      const lng = parseFloat(p.lon);
      
      if (isNaN(lat) || isNaN(lng) || lat === 0 || lng === 0) continue;
      
      const scheduled_time = p.time ? p.time.split('~')[0] + ':00' : null;

      allStopsToInsert.push({
        route_id: p.routeId,
        sequence_order: parseInt(p.seq, 10),
        point_name: p.pointName,
        address: p.address,
        lat: lat,
        lng: lng,
        scheduled_time: scheduled_time,
        location: `SRID=4326;POINT(${lng} ${lat})` // PostGIS well known text format for PostgREST
      });
      count++;
    }

    for (let i = 0; i < allStopsToInsert.length; i += batchSize) {
      const batch = allStopsToInsert.slice(i, i + batchSize);
      const { error: stopError } = await supabase.from('route_stops').insert(batch);
      if (stopError) throw stopError;
      console.log(`Inserted ${i + batch.length} stops...`);
    }

    console.log(`✅ Successfully seeded ${routesMap.size} routes and ${count} stops for all districts!`);

  } catch (e: any) {
    console.error("Error seeding:", e.message || e);
  }
}

run();
