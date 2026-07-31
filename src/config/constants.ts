export const MAP_CONSTANTS = {
  pageVersion: "20260731-viewport-lock",
} as const;

export const NOTIFICATION_CONSTANTS = {
  approachingMinutes: 5,
} as const;

export const TRUCK_SERVICE_CONSTANTS = {
  staleThresholdMs: 6 * 60 * 60 * 1000,
  staleWarnMs: 15 * 60 * 1000,
  defaultGarbageDays: [1, 2, 4, 5, 6] as const,
  officialLiveStatus: "1",
  carStatusDone: "1",
  altRouteRadiusMeters: 100,
  maxGpsSampleGapMs: 30 * 60 * 1000,
  minMovingSpeedKmh: 2,
  maxMovingSpeedKmh: 60,
  historicalSpeedWindowMinutes: 180,
  historicalSpeedMinSamples: 4,
  historicalArrivalMinSamples: 3,
  historicalEtaMaxMinutes: 180,
  liveTruckRefreshIntervalMs: 90 * 1000,
  historicalCacheTtlSeconds: 10 * 60,
} as const;