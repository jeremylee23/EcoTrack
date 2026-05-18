import { Client } from "pg";
import { config as dotenvConfig } from "dotenv";

dotenvConfig();

// We can just fetch it directly to be sure we get everything
async function fetchAllStops() {
  console.log("Fetching all districts data from HCCG...");
  const url = "https://7966.hccg.gov.tw/WEB/_IMP/API/CleanWeb/getPointData?address=";
  const response = await fetch(url, {
    headers: {
      Referer: "https://7966.hccg.gov.tw/WEB/cleanPoint.html",
      "User-Agent": "EcoTrack-Bot/1.0",
    },
  });
  const json = await response.json();
  return json.data.cleanPoint;
}

async function run() {
  const points = await fetchAllStops();
  console.log(`Fetched ${points.length} points.`);

  if (!process.env.SUPABASE_URL || !process.env.Database_Password) {
    throw new Error("Missing SUPABASE_URL or Database_Password in .env");
  }

  // Convert https://abc.supabase.co to postgres://postgres:password@db.abc.supabase.co:5432/postgres
  const dbHost = new URL(process.env.SUPABASE_URL).hostname.replace(/^[^.]+/, 'db');
  const connectionString = `postgresql://postgres:${process.env.Database_Password}@${dbHost}:5432/postgres`;

  const client = new Client(connectionString);

  try {
    await client.connect();
    console.log("Connected to DB.");

    // Extract unique routes
    const routesMap = new Map();
    for (const p of points) {
      if (!routesMap.has(p.routeId)) {
        routesMap.set(p.routeId, {
          id: p.routeId,
          name: p.routeName,
          type: "general", // MVP simplified
        });
      }
    }

    console.log(`Found ${routesMap.size} unique routes. Inserting...`);
    
    await client.query('BEGIN');

    // Upsert routes
    for (const route of routesMap.values()) {
      await client.query(
        `INSERT INTO public.truck_routes (id, name, type)
         VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
        [route.id, route.name, route.type]
      );
    }

    console.log("Inserting route stops...");
    
    // Clear existing stops to avoid duplicates or orphans if routes changed
    await client.query('TRUNCATE TABLE public.route_stops CASCADE');

    let count = 0;
    for (const p of points) {
      const lat = parseFloat(p.lat);
      const lng = parseFloat(p.lon);
      
      if (isNaN(lat) || isNaN(lng) || lat === 0 || lng === 0) continue;

      await client.query(
        `INSERT INTO public.route_stops (route_id, sequence_order, point_name, address, lat, lng, scheduled_time, location)
         VALUES ($1, $2, $3, $4, $5, $6, $7, ST_SetSRID(ST_MakePoint($6, $5), 4326))`,
        [
          p.routeId,
          parseInt(p.seq, 10),
          p.pointName,
          p.address,
          lat,
          lng,
          p.time,
        ]
      );
      count++;
      if (count % 500 === 0) console.log(`Inserted ${count} stops...`);
    }

    await client.query('COMMIT');
    console.log(`✅ Successfully seeded ${routesMap.size} routes and ${count} stops for all districts!`);

  } catch (e: any) {
    await client.query('ROLLBACK');
    console.error("Error seeding:", e.message);
  } finally {
    await client.end();
  }
}

run();
