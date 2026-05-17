const { Client } = require("pg");

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

  const client = new Client(
    "postgresql://postgres:3z3g6ZVpeLOBFR8f@db.xsytkncomjcypfesxsbw.supabase.co:5432/postgres"
  );

  try {
    await client.connect();
    console.log("Connected to DB.");

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
    await client.query('BEGIN');

    for (const route of routesMap.values()) {
      await client.query(
        `INSERT INTO public.truck_routes (id, name, type)
         VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
        [route.id, route.name, route.type]
      );
    }

    console.log("Inserting route stops...");
    await client.query('TRUNCATE TABLE public.route_stops CASCADE');

    let count = 0;
    for (const p of points) {
      const lat = parseFloat(p.lat);
      const lng = parseFloat(p.lon);
      
      if (isNaN(lat) || isNaN(lng) || lat === 0 || lng === 0) continue;

      // Clean the time string: "12:46~12:47" -> "12:46"
      // Or "14:30" -> "14:30"
      // If it's completely malformed or empty, pass null
      let scheduledTime = p.time;
      if (scheduledTime) {
         scheduledTime = scheduledTime.split('~')[0].trim();
         // Basic validation: does it match HH:mm or HH:mm:ss?
         if (!/^\\d{1,2}:\\d{2}(:\\d{2})?$/.test(scheduledTime)) {
            scheduledTime = null;
         }
      } else {
         scheduledTime = null;
      }

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
          scheduledTime,
        ]
      );
      count++;
      if (count % 500 === 0) console.log(`Inserted ${count} stops...`);
    }

    await client.query('COMMIT');
    console.log(`✅ Successfully seeded ${routesMap.size} routes and ${count} stops for all districts!`);

  } catch (e) {
    await client.query('ROLLBACK');
    console.error("Error seeding:", e.message);
  } finally {
    await client.end();
  }
}

run();
