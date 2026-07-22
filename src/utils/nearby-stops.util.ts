/**
 * Rank nearby clean points for "which stop should I walk to?"
 * Pure helpers — no I/O.
 */

export type NearbyStopStatus = "live" | "upcoming" | "passed" | "no_service";

export interface RankableStop {
  id: string;
  distanceMeters: number;
  /** Official live ETA minutes if any */
  etaMinutes?: number;
  minutesUntilScheduled: number | null;
  hasTodayService: boolean;
  status: NearbyStopStatus;
}

export function isStopStillUsefulToday(stop: RankableStop): boolean {
  return stop.status === "live" || stop.status === "upcoming";
}

/** Sort key: smaller = sooner useful arrival. */
export function soonestSortKey(stop: RankableStop): number {
  if (stop.etaMinutes !== undefined) return stop.etaMinutes;
  if (stop.minutesUntilScheduled !== null && stop.minutesUntilScheduled >= -120) {
    // Mildly late still counts as "coming"
    return Math.max(0, stop.minutesUntilScheduled);
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * Pick recommendation:
 * 1) Soonest still-useful stop (live/upcoming)
 * 2) Else nearest still-useful
 * 3) Else nearest overall (likely no_service / passed → show next day elsewhere)
 */
export function recommendNearbyStop<T extends RankableStop>(
  stops: T[]
): { stop: T; reason: string } | null {
  if (stops.length === 0) return null;

  const useful = stops.filter(isStopStillUsefulToday);
  if (useful.length > 0) {
    const bySoonest = [...useful].sort(
      (a, b) => soonestSortKey(a) - soonestSortKey(b) || a.distanceMeters - b.distanceMeters
    );
    const soonest = bySoonest[0];
    const nearestUseful = [...useful].sort(
      (a, b) => a.distanceMeters - b.distanceMeters
    )[0];

    // If nearest already passed but 2nd is useful — soonest path handles it.
    // Prefer soonest when it is meaningfully different from pure nearest.
    if (
      soonest.id !== nearestUseful.id &&
      soonestSortKey(soonest) + 5 < soonestSortKey(nearestUseful)
    ) {
      return {
        stop: soonest,
        reason: "下次最快到來（含距離）",
      };
    }

    // Nearest useful; if nearest overall was passed, this is "第二近還能等"
    const nearestOverall = [...stops].sort(
      (a, b) => a.distanceMeters - b.distanceMeters
    )[0];
    if (
      !isStopStillUsefulToday(nearestOverall) &&
      nearestUseful.id !== nearestOverall.id
    ) {
      return {
        stop: nearestUseful,
        reason: "最近的已錯過，改推第二近還能等的",
      };
    }

    return {
      stop: nearestUseful,
      reason: "最近且今日還能等",
    };
  }

  const nearest = [...stops].sort(
    (a, b) => a.distanceMeters - b.distanceMeters
  )[0];
  return {
    stop: nearest,
    reason: "附近今日已過或無班，顯示最近點的下次時間",
  };
}
