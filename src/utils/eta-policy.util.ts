import { SCHEDULE_LATE_GRACE_MINUTES } from "./time.util.js";

export type EtaSource = "official" | "estimated";

/**
 * Schedule-only "passed" check used when there is no live GPS proof.
 * Trucks are often late, so we require the late-grace window.
 */
export function isSchedulePastGrace(
  hasTodayService: boolean,
  minutesUntilScheduled: number | null,
  lateGraceMinutes: number = SCHEDULE_LATE_GRACE_MINUTES
): boolean {
  if (!hasTodayService) return true;
  if (minutesUntilScheduled === null) return false;
  return minutesUntilScheduled < -lateGraceMinutes;
}

/**
 * Live GPS proof that the truck has already passed the target stop.
 */
export function isSequencePastStop(
  headingToStopSequence: number,
  targetSequence: number
): boolean {
  return headingToStopSequence > targetSequence;
}

/**
 * Clamp historical ETA bias so one bad day cannot warp estimates too far.
 */
export function clampEtaBiasMinutes(bias: number): number {
  if (!Number.isFinite(bias)) return 0;
  return Math.max(-15, Math.min(15, Math.round(bias)));
}

/**
 * Apply bias to a raw estimate. Positive bias means we historically overestimated.
 */
export function applyEtaBias(rawMinutes: number, biasMinutes: number): number {
  return Math.max(1, Math.round(rawMinutes - biasMinutes));
}
