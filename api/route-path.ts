/**
 * GET /api/route-path?routeId=181&lat=24.8&lng=120.9
 * Full route polyline + closest wait point to home with ETA.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getRoutePathForMap } from "../src/services/truck.service.js";

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader(
    "Cache-Control",
    "public, s-maxage=60, stale-while-revalidate=120"
  );

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "GET") {
    res.status(405).json({ error: "Method Not Allowed" });
    return;
  }

  const routeId = String(req.query.routeId ?? "").trim();
  if (!routeId) {
    res.status(400).json({ error: "routeId required" });
    return;
  }

  const lat =
    req.query.lat !== undefined ? parseFloat(String(req.query.lat)) : undefined;
  const lng =
    req.query.lng !== undefined ? parseFloat(String(req.query.lng)) : undefined;
  const routeName =
    typeof req.query.routeName === "string" ? req.query.routeName : undefined;
  const focusLat =
    req.query.focusLat !== undefined
      ? parseFloat(String(req.query.focusLat))
      : undefined;
  const focusLng =
    req.query.focusLng !== undefined
      ? parseFloat(String(req.query.focusLng))
      : undefined;
  const focusName =
    typeof req.query.focusName === "string" ? req.query.focusName : undefined;

  try {
    const path = await getRoutePathForMap(routeId, {
      nearLat: Number.isFinite(lat) ? lat : undefined,
      nearLng: Number.isFinite(lng) ? lng : undefined,
      routeName,
      focusLat: Number.isFinite(focusLat) ? focusLat : undefined,
      focusLng: Number.isFinite(focusLng) ? focusLng : undefined,
      focusName,
    });

    const closest = path.closest;
    const tipParts = ["藍線＝完整清運路線"];
    if (path.liveGarbageTruck) tipParts.push("🚛＝垃圾車即時 GPS");
    if (path.focus) tipParts.push("紅旗＝你目前看的清運點");
    if (closest) {
      tipParts.push(
        `橘標＝離你定位最近的等候點（約 ${closest.distanceMeters}m）`
      );
    }
    if (path.upcomingStops.length > 0) tipParts.push("藍標＝接下來 5 站 ETA");
    const tip = tipParts.join("；") + "。";

    res.status(200).json({
      ...path,
      tip,
    });
  } catch (err) {
    console.error("[route-path]", err);
    res.status(500).json({ error: "failed to load route path" });
  }
}
