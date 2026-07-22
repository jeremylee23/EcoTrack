import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseDayList,
  formatWeekSchedule,
  buildNoServiceTodayMessage,
} from "../services/schedule.service.js";

describe("schedule.service", () => {
  it("parses trash day lists", () => {
    assert.deepEqual(parseDayList("1,2,4,5,6"), [1, 2, 4, 5, 6]);
    assert.deepEqual(parseDayList(""), []);
  });

  it("formats weekly schedule with Wednesday note", () => {
    const text = formatWeekSchedule({
      stopName: "測試站",
      scheduledTime: "18:30~18:35",
      trashDays: "1,2,4,5,6",
      recycleDays: "1,5",
    });
    assert.match(text, /測試站/);
    assert.match(text, /週三不收運/);
    assert.match(text, /垃圾車：週一、週二、週四、週五、週六/);
  });

  it("builds stronger no-service message than official banner", () => {
    const text = buildNoServiceTodayMessage({
      stopName: "東門站",
      weekday: 3,
      nextGarbageDate: "07-23 (四) 18:30",
    });
    assert.match(text, /今日無收運服務/);
    assert.match(text, /下次垃圾車：07-23/);
    assert.match(text, /班表/);
  });
});
