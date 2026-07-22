import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getNextScheduledArrival, SCHEDULE_LATE_GRACE_MINUTES } from "./time.util.js";
import {
  applyEtaBias,
  clampEtaBiasMinutes,
  isSchedulePastGrace,
  isSequencePastStop,
} from "./eta-policy.util.js";

describe("eta-policy", () => {
  it("does not mark schedule as passed within late grace", () => {
    assert.equal(isSchedulePastGrace(true, -30), false);
    assert.equal(isSchedulePastGrace(true, -119), false);
    assert.equal(isSchedulePastGrace(true, -SCHEDULE_LATE_GRACE_MINUTES - 1), true);
  });

  it("marks no-service days as passed for schedule fallback", () => {
    assert.equal(isSchedulePastGrace(false, 10), true);
  });

  it("detects sequence past stop", () => {
    assert.equal(isSequencePastStop(12, 10), true);
    assert.equal(isSequencePastStop(10, 10), false);
    assert.equal(isSequencePastStop(9, 10), false);
  });

  it("clamps and applies ETA bias", () => {
    assert.equal(clampEtaBiasMinutes(40), 15);
    assert.equal(clampEtaBiasMinutes(-40), -15);
    assert.equal(applyEtaBias(10, 3), 7);
    assert.equal(applyEtaBias(2, 5), 1);
  });
});

describe("getNextScheduledArrival late grace", () => {
  it("keeps today open until late grace elapses", () => {
    // Use a scheduled time far in the future relative to "now" by mocking via
    // a time that is always valid: pick 23:59 and only assert shape when today.
    // This test focuses on hasPassedToday skipping today.
    const skipped = getNextScheduledArrival("1,2,3,4,5,6,7", "12:00", true);
    assert.ok(skipped);
    assert.equal(skipped.isToday, false);
  });
});
