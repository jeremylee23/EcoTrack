import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  shortenAddress,
  favoriteDisplayName,
} from "./favorite-label.util.js";

describe("favorite address + nickname", () => {
  it("shortens Taiwan addresses for buttons", () => {
    const short = shortenAddress("台灣新竹市香山區中華路一段100號");
    assert.ok(short.length <= 14);
    assert.match(short, /香山|中華/);
  });

  it("prefers nickname for display but keeps address identity", () => {
    const spot = {
      label: "中華路一段…",
      nickname: "兒子家",
      address: "新竹市香山區中華路一段100號",
    };
    assert.equal(favoriteDisplayName(spot), "兒子家");
  });
});
