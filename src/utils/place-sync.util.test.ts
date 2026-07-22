import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  addressesLikelySame,
  coordsWithinMeters,
  isSamePlace,
  normalizeAddressKey,
} from "./place-sync.util.js";

describe("place-sync", () => {
  it("normalizes addresses for comparison", () => {
    assert.equal(
      normalizeAddressKey("台灣新竹市北區光華北街81號"),
      normalizeAddressKey("新竹市北區光華北街81號")
    );
  });

  it("treats short label as same as full address", () => {
    assert.equal(
      addressesLikelySame("新竹市北區光華北街81號", "光華北街81號"),
      true
    );
  });

  it("detects same place by GPS or address", () => {
    assert.equal(
      coordsWithinMeters(24.81727, 120.9716, 24.8173, 120.97165, 40),
      true
    );
    assert.equal(
      isSamePlace({
        homeLat: 24.81727,
        homeLng: 120.9716,
        homeAddress: "新竹市北區光華北街81號",
        spotLat: 24.82,
        spotLng: 120.98,
        spotAddress: "光華北街81號",
      }),
      true
    );
  });
});
