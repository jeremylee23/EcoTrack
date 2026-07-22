import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { recommendNearbyStop } from "./nearby-stops.util.js";

describe("recommendNearbyStop", () => {
  it("prefers soonest useful over farther later stop", () => {
    const pick = recommendNearbyStop([
      {
        id: "near-passed",
        distanceMeters: 30,
        minutesUntilScheduled: -150,
        hasTodayService: true,
        status: "passed",
      },
      {
        id: "soon",
        distanceMeters: 80,
        minutesUntilScheduled: 20,
        hasTodayService: true,
        status: "upcoming",
      },
      {
        id: "later",
        distanceMeters: 50,
        minutesUntilScheduled: 90,
        hasTodayService: true,
        status: "upcoming",
      },
    ]);
    assert.ok(pick);
    assert.equal(pick!.stop.id, "soon");
    assert.match(pick!.reason, /錯過|最快/);
  });

  it("uses live ETA when present", () => {
    const pick = recommendNearbyStop([
      {
        id: "a",
        distanceMeters: 40,
        minutesUntilScheduled: 60,
        hasTodayService: true,
        status: "upcoming",
      },
      {
        id: "b",
        distanceMeters: 90,
        etaMinutes: 8,
        minutesUntilScheduled: 30,
        hasTodayService: true,
        status: "live",
      },
    ]);
    assert.equal(pick?.stop.id, "b");
  });
});
