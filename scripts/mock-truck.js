const { Redis } = require("@upstash/redis");
const { createClient } = require("@supabase/supabase-js");
const fs = require("fs");

function getEnv() {
  const envFile = fs.readFileSync(".env", "utf8");
  const env = {};
  envFile.split("\n").forEach(line => {
    const parts = line.split("=");
    if (parts.length >= 2) {
      env[parts[0]] = parts.slice(1).join("=").replace(/"/g, '');
    }
  });
  return env;
}

async function run() {
  const env = getEnv();
  const supabase = createClient(
    env.SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY
  );

  const redis = new Redis({
    url: env.UPSTASH_REDIS_REST_URL,
    token: env.UPSTASH_REDIS_REST_TOKEN,
  });

  const { data: users } = await supabase.from('users').select('*').limit(1);
  if (!users || users.length === 0) {
    console.log("No users found. Please register a location on LINE first!");
    return;
  }

  const user = users[0];
  const userLat = user.home_lat;
  const userLng = user.home_lng;

  const { data: stops } = await supabase.rpc("find_nearest_stop", {
    p_lat: userLat,
    p_lng: userLng,
    p_radius_meters: 1500,
  });

  if (!stops || (Array.isArray(stops) && stops.length === 0)) {
    console.log("No stops found near user.");
    return;
  }

  const stop = Array.isArray(stops) ? stops[0] : stops;
  console.log(`Target stop: ${stop.point_name || stop.address} (Route: ${stop.route_id}, Seq: ${stop.sequence_order})`);

  const fakeTruck = {
    lat: stop.lat - 0.003, 
    lng: stop.lng - 0.003, 
    speed: 15,
    updated_at: new Date().toISOString(),
    heading_to_stop_sequence: Math.max(0, stop.sequence_order - 2), 
    car_no: "MOCK-999",
    route_name: "測試模擬路線",
    status: "0",
    direction: "0"
  };

  const key = `truck_live:${stop.route_id}`;
  await redis.set(key, fakeTruck, { ex: 3600 }); 

  console.log(`✅ Mock truck injected to Redis key: ${key}`);
  console.log(`Truck location: ${fakeTruck.lat}, ${fakeTruck.lng}`);
  console.log(`Now open your LINE bot and click "查詢 ETA" to see the magic!`);
}

run();
