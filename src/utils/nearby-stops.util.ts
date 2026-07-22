/**
 * Rank nearby clean points for "which stop should I walk to?"
 * Pure helpers — no I/O.
 *
 * Rule for seniors on a main road (e.g. 光華北街):
 * Prefer same-street MAIN-ROAD pins over slightly closer alley pins.
 * Truck often collects along the main street — do not send people into 巷.
 */

export type NearbyStopStatus = "live" | "upcoming" | "passed" | "no_service";

/** Allow main-road pin to be this much farther than nearest alley. */
export const MAIN_STREET_DISTANCE_SLACK_M = 220;

/** streetAffinityScore threshold: matched same road */
export const STREET_MATCH_SCORE = 100;

/** Main-road (non-alley) match — strongly preferred over 巷/弄 */
export const MAIN_STREET_SCORE = 130;

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
    return Math.max(0, stop.minutesUntilScheduled);
  }
  return Number.POSITIVE_INFINITY;
}

function streetScoreOf(stop: RankableStop): number {
  return stop.streetScore ?? 0;
}

function isMainStreetPin(stop: RankableStop): boolean {
  return streetScoreOf(stop) >= MAIN_STREET_SCORE;
}

/**
 * Pick recommendation — single source of truth for Flex / ETA / map.
 *
 * Priority when today still useful:
 * 1) Same-street MAIN ROAD within slack distance (avoid 巷)
 * 2) Soonest useful (live ETA / schedule)
 * 3) Nearest useful
 *
 * When today done: earliest next in area, then street, then distance.
 */
export function recommendNearbyStop<T extends RankableStop>(
  stops: T[]
): { stop: T; reason: string } | null {
  if (stops.length === 0) return null;

  const useful = stops.filter(isStopStillUsefulToday);
  if (useful.length > 0) {
    const nearestUseful = [...useful].sort(
      (a, b) =>
        a.distanceMeters - b.distanceMeters ||
        streetScoreOf(b) - streetScoreOf(a)
    )[0];

    const byStreetThenNear = [...useful].sort(
      (a, b) =>
        streetScoreOf(b) - streetScoreOf(a) ||
        a.distanceMeters - b.distanceMeters ||
        soonestSortKey(a) - soonestSortKey(b)
    );
    const streetBest = byStreetThenNear[0];

    // ── Strong rule: main-road same street beats alley ─────────────
    if (
      streetBest &&
      isMainStreetPin(streetBest) &&
      streetBest.distanceMeters <=
        nearestUseful.distanceMeters + MAIN_STREET_DISTANCE_SLACK_M
    ) {
      const soonerMain = [...useful]
        .filter(isMainStreetPin)
        .sort(
          (a, b) =>
            soonestSortKey(a) - soonestSortKey(b) ||
            a.distanceMeters - b.distanceMeters
        )[0];
      const pick = soonerMain ?? streetBest;
      if (
        streetScoreOf(pick) > streetScoreOf(nearestUseful) ||
        isMainStreetPin(pick)
      ) {
        return {
          stop: pick,
          reason: "同路段主街清運點（車會經過，不必走進巷內）",
        };
      }
    }

    // Weaker same-street match (still better than random alley)
    if (
      streetBest &&
      streetScoreOf(streetBest) >= STREET_MATCH_SCORE &&
      streetScoreOf(streetBest) > streetScoreOf(nearestUseful) &&
      streetBest.distanceMeters <=
        nearestUseful.distanceMeters + MAIN_STREET_DISTANCE_SLACK_M
    ) {
      return {
        stop: streetBest,
        reason: "同路段清運點",
      };
    }

    const bySoonest = [...useful].sort(
      (a, b) =>
        soonestSortKey(a) - soonestSortKey(b) ||
        streetScoreOf(b) - streetScoreOf(a) ||
        a.distanceMeters - b.distanceMeters
    );
    const soonest = bySoonest[0];

    if (
      soonest.id !== nearestUseful.id &&
      soonestSortKey(soonest) + 5 < soonestSortKey(nearestUseful)
    ) {
      // Don't send seniors into an alley just because it's 5 min sooner
      if (
        isMainStreetPin(streetBest) &&
        !isMainStreetPin(soonest) &&
        soonestSortKey(streetBest) <= soonestSortKey(soonest) + 40
      ) {
        return {
          stop: streetBest,
          reason: "同路段主街清運點（車會經過，不必走進巷內）",
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
      if (
        isMainStreetPin(streetBest) &&
        streetBest.distanceMeters <=
          nearestUseful.distanceMeters + MAIN_STREET_DISTANCE_SLACK_M
      ) {
        return {
          stop: streetBest,
          reason: "最近的已錯過，改推同街主街還能等的",
        };
      }
      return {
        stop: nearestUseful,
        reason: "最近的已錯過，改推第二近還能等的",
      };
    }

    return {
      stop: nearestUseful,
      reason: isMainStreetPin(nearestUseful)
        ? "同路段主街、今日還能等"
        : "最近且今日還能等",
    };
  }

  // Today done: earliest next arrival, prefer main street when tied.
  const withNext = stops.filter((s) => s.nextSortKey !== undefined);
  if (withNext.length > 0) {
    const earliest = [...withNext].sort(
      (a, b) =>
        (a.nextSortKey ?? Number.POSITIVE_INFINITY) -
          (b.nextSortKey ?? Number.POSITIVE_INFINITY) ||
        streetScoreOf(b) - streetScoreOf(a) ||
        a.distanceMeters - b.distanceMeters
    )[0];

    // If earliest is alley but a main-street pin is same day/time window, prefer main
    const mainAlt = [...withNext]
      .filter(isMainStreetPin)
      .sort(
        (a, b) =>
          (a.nextSortKey ?? Number.POSITIVE_INFINITY) -
            (b.nextSortKey ?? Number.POSITIVE_INFINITY) ||
          a.distanceMeters - b.distanceMeters
      )[0];
    if (
      mainAlt &&
      !isMainStreetPin(earliest) &&
      (mainAlt.nextSortKey ?? Infinity) <=
        (earliest.nextSortKey ?? Infinity) + 180 &&
      mainAlt.distanceMeters <=
        earliest.distanceMeters + MAIN_STREET_DISTANCE_SLACK_M
    ) {
      return {
        stop: mainAlt,
        reason: "附近下次最早班，優先同街主街等候",
      };
    }

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
    reason: "附近今日已過或無班，顯示建議點的下次時間",
  };
}

/**
 * Shared candidate pick for calculateEta — mirrors recommendNearbyStop
 * using street scores + schedule usefulness (no Flex status needed).
 */
export function pickPreferredCandidateIndex(
  items: Array<{
    distanceMeters: number;
    minutesUntilScheduled: number | null;
    etaMinutes?: number;
    hasTodayService: boolean;
    streetScore: number;
    passed: boolean;
  }>
): number {
  if (items.length === 0) return -1;
  const ranked = items.map((it, index) => {
    let status: NearbyStopStatus = "upcoming";
    if (!it.hasTodayService) status = "no_service";
    else if (it.passed) status = "passed";
    else if (it.etaMinutes !== undefined) status = "live";
    return {
      id: String(index),
      index,
      distanceMeters: it.distanceMeters,
      minutesUntilScheduled: it.minutesUntilScheduled,
      etaMinutes: it.etaMinutes,
      hasTodayService: it.hasTodayService,
      status,
      streetScore: it.streetScore,
    };
  });
  const pick = recommendNearbyStop(ranked);
  return pick ? pick.stop.index : 0;
}
