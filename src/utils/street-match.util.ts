/**
 * Street / alley affinity for ranking clean points near home.
 * Pure helpers — no I/O.
 */

/** Extract main road/street name, e.g. 光華北街 from 新竹市北區光華北街36巷9號. */
export function extractRoadName(text: string | null | undefined): string | null {
  if (!text?.trim()) return null;
  const s = text
    .trim()
    .replace(/\s+/g, "")
    .replace(/^台灣/, "")
    .replace(/^臺灣/, "")
    .replace(/^新竹市/, "")
    .replace(/^新竹縣/, "")
    .replace(/^[\u4e00-\u9fff]{1,3}區/, "");

  // Collect 路/街/道 tokens; prefer the one that sits before 巷/弄/號.
  const matches = [...s.matchAll(/([0-9\u4e00-\u9fff]{1,10}(?:路|街|道|大道))/g)];
  if (matches.length === 0) return null;

  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    const after = s.slice((m.index ?? 0) + m[0].length);
    if (/^(?:\d*巷|\d*弄|\d+-?\d*號|$)/.test(after)) {
      return m[1];
    }
  }
  return matches[matches.length - 1][1];
}

export function isAlleyPlace(name: string, address = ""): boolean {
  return /巷|弄/.test(`${name}${address}`);
}

/** Home sits on an alley (…街36巷…) rather than the main road only. */
export function homeIsOnAlley(homeAddress: string | null | undefined): boolean {
  if (!homeAddress) return false;
  const s = homeAddress.replace(/\s+/g, "");
  return /(?:路|街|道|大道)\d*巷|巷\d+|弄\d*/.test(s);
}

/**
 * Higher = better match to where the senior actually lives.
 * Same street main-road beats same-street alley when home is on the main road
 * (truck often passes 光華北街 even if an alley pin is slightly closer).
 */
export function streetAffinityScore(
  homeAddress: string | null | undefined,
  stopName: string,
  stopAddress = ""
): number {
  if (!homeAddress?.trim()) return 0;
  const road = extractRoadName(homeAddress);
  if (!road) return 0;

  const blob = `${stopName}${stopAddress}`;
  if (!blob.includes(road)) return 0;

  let score = 100;
  const homeAlley = homeIsOnAlley(homeAddress);
  const stopAlley = isAlleyPlace(stopName, stopAddress);

  if (!homeAlley && !stopAlley) score += 40; // both on main road
  else if (!homeAlley && stopAlley) score -= 35; // don't pull seniors into alleys
  else if (homeAlley && stopAlley) score += 25; // alley resident → alley stop OK
  else score += 5; // alley home but main-road stop still fine

  return score;
}
