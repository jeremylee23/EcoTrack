/**
 * Pick earliest next arrival across many nearby stops (area-wide).
 * Pure helpers — no I/O.
 */

import {
  getNextScheduledArrival,
  SCHEDULE_LATE_GRACE_MINUTES,
} from "./time.util.js";

export interface NextArrivalCandidate {
  id: string;
  name: string;
  daysString: string | null;
  scheduledTime: string | null;
  hasPassedToday: boolean;
  defaultDays?: number[];
}

export interface EarliestNextArrival {
  dateStr: string;
  isToday: boolean;
  /** daysAhead * 1440 + clock minutes — smaller = sooner */
  sortKey: number;
  stopId: string;
  stopName: string;
  scheduledTime: string;
}

function parseSortKey(dateStr: string, isToday: boolean): number | null {
  const timeMatch = dateStr.match(/(\d{1,2}):(\d{2})\s*$/);
  if (!timeMatch) return null;
  const clock = parseInt(timeMatch[1], 10) * 60 + parseInt(timeMatch[2], 10);
  if (isToday) return clock;

  const md = dateStr.match(/(\d{2})\/(\d{2})/);
  if (!md) return 1440 + clock; // unknown future day — still after today
  // Rough absolute key within the year (enough to compare nearby stops)
  const month = parseInt(md[1], 10);
  const day = parseInt(md[2], 10);
  return month * 32 * 1440 + day * 1440 + clock;
}

/**
 * Scan all nearby stop schedules; return the soonest next garbage pickup.
 * Fixes: locking onto one evening pin while afternoon service exists nearby.
 */
export function pickEarliestNextArrival(
  stops: NextArrivalCandidate[],
  lateGraceMinutes: number = SCHEDULE_LATE_GRACE_MINUTES
): EarliestNextArrival | null {
  let best: EarliestNextArrival | null = null;

  for (const s of stops) {
    if (!s.scheduledTime) continue;
    const info = getNextScheduledArrival(
      s.daysString,
      s.scheduledTime,
      s.hasPassedToday,
      s.defaultDays,
      lateGraceMinutes
    );
    if (!info) continue;
    const sortKey = parseSortKey(info.dateStr, info.isToday);
    if (sortKey === null) continue;

    const row: EarliestNextArrival = {
      dateStr: info.dateStr,
      isToday: info.isToday,
      sortKey,
      stopId: s.id,
      stopName: s.name,
      scheduledTime: s.scheduledTime,
    };
    if (!best || row.sortKey < best.sortKey) best = row;
  }

  return best;
}
