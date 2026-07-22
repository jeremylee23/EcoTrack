import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractRoadName,
  homeIsOnAlley,
  streetAffinityScore,
} from "./street-match.util.js";
import { pickEarliestNextArrival } from "./area-next-arrival.util.js";
import { recommendNearbyStop } from "./nearby-stops.util.js";

describe("street-match", () => {
  it("extracts 光華北街 from alley address", () => {
    assert.equal(
      extractRoadName("新竹市北區光華北街36巷9號"),
      "光華北街"
    );
  });

  it("detects alley home vs main-road home", () => {
    assert.equal(homeIsOnAlley("新竹市光華北街36巷9號"), true);
    assert.equal(homeIsOnAlley("新竹市光華北街81號"), false);
  });

  it("prefers main-road stop when home is on main road", () => {
    const home = "新竹市北區光華北街80號";
    const main = streetAffinityScore(home, "光華北街51號", "新竹市光華北街51號");
    const alley = streetAffinityScore(
      home,
      "光華北街36巷9號",
      "新竹市光華北街36巷9號"
    );
    assert.ok(main > alley);
  });
});

describe("pickEarliestNextArrival", () => {
  it("picks afternoon over evening next day", () => {
    const best = pickEarliestNextArrival([
      {
        id: "eve",
        name: "光華北街36巷9號",
        daysString: "1,2,4,5,6",
        scheduledTime: "19:57",
        hasPassedToday: true,
        defaultDays: [1, 2, 4, 5, 6],
      },
      {
        id: "aft",
        name: "光華北街81-51號",
        daysString: "1,4",
        scheduledTime: "14:17",
        hasPassedToday: true,
        defaultDays: [1, 2, 4, 5, 6],
      },
    ]);
    assert.ok(best);
    assert.equal(best!.stopId, "aft");
    assert.match(best!.dateStr, /14:17/);
  });
});

describe("recommendNearbyStop street + next", () => {
  it("prefers main-street stop over closer alley when times are similar", () => {
    const pick = recommendNearbyStop([
      {
        id: "alley",
        distanceMeters: 40,
        minutesUntilScheduled: 50,
        hasTodayService: true,
        status: "upcoming",
        streetScore: 65,
      },
      {
        id: "main",
        distanceMeters: 70,
        minutesUntilScheduled: 55,
        hasTodayService: true,
        status: "upcoming",
        streetScore: 140,
      },
    ]);
    assert.equal(pick?.stop.id, "main");
    assert.match(pick!.reason, /主街|同路段/);
  });

  it("when today passed, picks earliest next not nearest", () => {
    const pick = recommendNearbyStop([
      {
        id: "near-eve",
        distanceMeters: 30,
        minutesUntilScheduled: -200,
        hasTodayService: true,
        status: "passed",
        streetScore: 65,
        nextSortKey: 9000,
      },
      {
        id: "far-aft",
        distanceMeters: 90,
        minutesUntilScheduled: -200,
        hasTodayService: true,
        status: "passed",
        streetScore: 140,
        nextSortKey: 1000,
      },
    ]);
    assert.equal(pick?.stop.id, "far-aft");
    assert.match(pick!.reason, /最早/);
  });
});
