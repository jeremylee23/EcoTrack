import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractRoadName,
  homeIsOnAlley,
  streetAffinityScore,
} from "./street-match.util.js";
import { pickEarliestNextArrival } from "./area-next-arrival.util.js";
import {
  MAIN_STREET_DISTANCE_SLACK_M,
  pickPreferredEtaCandidateIndex,
  recommendNearbyStop,
} from "./nearby-stops.util.js";

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
    assert.ok(main >= 130);
  });
});

describe("pickEarliestNextArrival", () => {
  it("picks afternoon over evening next day", () => {
    const RealDate = Date;
    class MockDate extends Date {
      constructor(...args: any[]) {
        if (args.length === 0) {
          super("2026-07-28T12:00:00+08:00");
          return;
        }
        super(args[0]);
      }
      static now(): number {
        return new RealDate("2026-07-28T12:00:00+08:00").getTime();
      }
    }

    // Freeze on Tuesday so both candidates land on Thursday; 14:17 should beat 19:57.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.Date = MockDate as any;
    try {
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
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      globalThis.Date = RealDate as any;
    }
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

  it("prefers main street even when alley is much closer (within slack)", () => {
    const alleyDist = 35;
    const mainDist = alleyDist + MAIN_STREET_DISTANCE_SLACK_M - 10;
    const pick = recommendNearbyStop([
      {
        id: "alley-36",
        distanceMeters: alleyDist,
        minutesUntilScheduled: 40,
        hasTodayService: true,
        status: "upcoming",
        streetScore: 65,
      },
      {
        id: "main-51",
        distanceMeters: mainDist,
        minutesUntilScheduled: 45,
        hasTodayService: true,
        status: "upcoming",
        streetScore: 140,
      },
    ]);
    assert.equal(pick?.stop.id, "main-51");
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
    assert.match(pick!.reason, /最早|主街/);
  });
});

describe("pickPreferredEtaCandidateIndex", () => {
  it("maps ETA candidates through the shared domain ranking policy", () => {
    const index = pickPreferredEtaCandidateIndex(
      [
        {
          distanceMeters: 35,
          minutesUntilScheduled: 40,
          hasTodayService: true,
          pointName: "光華北街36巷9號",
          address: "新竹市光華北街36巷9號",
        },
        {
          distanceMeters: 85,
          minutesUntilScheduled: 45,
          hasTodayService: true,
          pointName: "光華北街81號",
          address: "新竹市光華北街81號",
        },
      ],
      "新竹市北區光華北街80號"
    );

    assert.equal(index, 1);
  });
});
