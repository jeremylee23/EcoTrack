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
  /** Same-street / main-road affinity (higher = better for this home) */
  streetScore?: number;
  /** Area next-arrival sort key (smaller = sooner); used when today is done */
  nextSortKey?: number;
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

function streetScoreOf(stop: RankableStop): number {
  return stop.streetScore ?? 0;
}

/**
 * Pick recommendation:
 * 1) Still-useful today: soonest, then same-street / main-road, then nearest
 * 2) Else earliest next arrival in the area, then street, then nearest
 */
export function recommendNearbyStop<T extends RankableStop>(
  stops: T[]
): { stop: T; reason: string } | null {
  if (stops.length === 0) return null;

  const useful = stops.filter(isStopStillUsefulToday);
  if (useful.length > 0) {
    const bySoonest = [...useful].sort(
      (a, b) =>
        soonestSortKey(a) - soonestSortKey(b) ||
        streetScoreOf(b) - streetScoreOf(a) ||
        a.distanceMeters - b.distanceMeters
    );
    const soonest = bySoonest[0];

    // Prefer same-street main-road when it is not meaningfully later.
    const byStreetThenNear = [...useful].sort(
      (a, b) =>
        streetScoreOf(b) - streetScoreOf(a) ||
        a.distanceMeters - b.distanceMeters ||
        soonestSortKey(a) - soonestSortKey(b)
    );
    const streetBest = byStreetThenNear[0];
    if (
      streetBest &&
      streetScoreOf(streetBest) >= 100 &&
      streetScoreOf(streetBest) > streetScoreOf(soonest) &&
      soonestSortKey(streetBest) <= soonestSortKey(soonest) + 45 &&
      streetBest.distanceMeters <= soonest.distanceMeters + 120
    ) {
      return {
        stop: streetBest,
        reason: "同路段主街清運點（車會經過，不必走進巷內）",
      };
    }

    const nearestUseful = [...useful].sort(
      (a, b) =>
        a.distanceMeters - b.distanceMeters ||
        streetScoreOf(b) - streetScoreOf(a)
    )[0];

    if (
      soonest.id !== nearestUseful.id &&
      soonestSortKey(soonest) + 5 < soonestSortKey(nearestUseful)
    ) {
      // Still avoid alley if street main-road is close enough in time
      if (
        streetScoreOf(streetBest) > streetScoreOf(soonest) &&
        soonestSortKey(streetBest) <= soonestSortKey(soonest) + 20
      ) {
        return {
          stop: streetBest,
          reason: "同路段清運點，時間也接近",
        };
      }
      return {
        stop: soonest,
        reason: "下次最快到來（含距離）",
      };
    }

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

    if (
      streetScoreOf(nearestUseful) >= 100 &&
      streetScoreOf(nearestUseful) > streetScoreOf(soonest)
    ) {
      return {
        stop: nearestUseful,
        reason: "同路段最近清運點",
      };
    }

    return {
      stop: nearestUseful,
      reason: "最近且今日還能等",
    };
  }

  // Today done: pick earliest next arrival in the area (not nearest evening pin).
  const withNext = stops.filter((s) => s.nextSortKey !== undefined);
  if (withNext.length > 0) {
    const earliest = [...withNext].sort(
      (a, b) =>
        (a.nextSortKey ?? Number.POSITIVE_INFINITY) -
          (b.nextSortKey ?? Number.POSITIVE_INFINITY) ||
        streetScoreOf(b) - streetScoreOf(a) ||
        a.distanceMeters - b.distanceMeters
    )[0];
    return {
      stop: earliest,
      reason: "附近下次最早的班（含下午／其他路線）",
    };
  }

  const nearest = [...stops].sort(
    (a, b) =>
      streetScoreOf(b) - streetScoreOf(a) ||
      a.distanceMeters - b.distanceMeters
  )[0];
  return {
    stop: nearest,
    reason: "附近今日已過或無班，顯示最近點的下次時間",
  };
}
