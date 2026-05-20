/**
 * config/index.ts
 * Environment variable validation & typed config object.
 * Fails fast if any required variable is missing.
 */

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) {
    throw new Error(
      `[Config] Missing required environment variable: ${key}. ` +
        `Please check your .env file or Vercel environment settings.`
    );
  }
  return val;
}

function optionalEnv(key: string, defaultValue = ""): string {
  return process.env[key] ?? defaultValue;
}

export const config = {
  // Supabase
  supabase: {
    url: requireEnv("SUPABASE_URL"),
    serviceRoleKey: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  },

  // Upstash Redis
  redis: {
    restUrl: requireEnv("UPSTASH_REDIS_REST_URL"),
    restToken: requireEnv("UPSTASH_REDIS_REST_TOKEN"),
  },

  // LINE Messaging API
  line: {
    channelId: requireEnv("LINE_CHANNEL_ID"),
    channelSecret: requireEnv("LINE_CHANNEL_SECRET"),
    channelAccessToken: requireEnv("LINE_CHANNEL_ACCESS_TOKEN"),
  },

  // Gemini API
  gemini: {
    apiKey: requireEnv("GEMINI_API_KEY"),
  },

  // Hsinchu City Government API
  hccg: {
    baseUrl: optionalEnv(
      "HCCG_API_BASE_URL",
      "https://7966.hccg.gov.tw/WEB/_IMP/API/CleanWeb"
    ),
    referer: "https://7966.hccg.gov.tw/WEB/cleanPoint.html",
  },

  // Domain constants
  hsinchu: {
    // ETA calculation constants (tuned for city garbage trucks)
    avgSpeedKmh: 10,
    stopDwellSeconds: 60,
    // Max search radius for nearest stop (meters)
    nearestStopRadiusMeters: 1500,
    // Redis TTL for live truck data (seconds)
    truckLiveTtlSeconds: 300,
    // Max plausible speed for teleport detection (km/h)
    maxPlausibleSpeedKmh: 80,
  },
} as const;

export type Config = typeof config;
