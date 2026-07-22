/**
 * Pure helpers for favorite place labels (no Redis / env).
 */

export interface FavoriteLabelSource {
  label: string;
  nickname?: string;
  address?: string;
}

/** Short, button-friendly label from LINE address. */
export function shortenAddress(raw: string | null | undefined): string {
  if (!raw?.trim()) return "新地點";
  let s = raw.trim();
  s = s.replace(/^台灣/, "").replace(/^臺灣/, "");
  s = s.replace(/^新竹市/, "").replace(/^新竹縣/, "");
  s = s.replace(/\s+/g, "");
  const road = s.match(
    /([\u4e00-\u9fff]{1,3}[區市鎮鄉].{0,12}?(?:路|街|道|巷|弄)[0-9\-]*號?)/
  );
  if (road?.[1]) s = road[1];
  if (s.length > 14) s = `${s.slice(0, 13)}…`;
  return s || "新地點";
}

/** Button text: nickname first, else short address. */
export function favoriteDisplayName(spot: FavoriteLabelSource): string {
  const nick = spot.nickname?.trim();
  if (nick) return nick;
  return spot.label;
}

/** Keep address visible under a nickname. */
export function favoriteSubtitle(spot: FavoriteLabelSource): string | null {
  if (spot.nickname?.trim()) {
    return spot.address?.trim() || spot.label;
  }
  return spot.address && spot.address !== spot.label ? spot.address : null;
}
