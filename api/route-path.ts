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

  try {
    const path = await getRoutePathForMap(routeId, {
      nearLat: Number.isFinite(lat) ? lat : undefined,
      nearLng: Number.isFinite(lng) ? lng : undefined,
      routeName,
    });

    const closest = path.closest;
    const tip = closest
      ? `藍線＝完整清運路線。橘色「在這等」＝離你家最近的路點（約 ${closest.distanceMeters}m）。${closest.statusLabel}`
      : "藍線＝垃圾車完整清運路線。往線附近等即可（沿路收，不一定要有旗子）。";

    res.status(200).json({
      ...path,
      tip,
    });
  } catch (err) {
    console.error("[route-path]", err);
    res.status(500).json({ error: "failed to load route path" });
  }
}
