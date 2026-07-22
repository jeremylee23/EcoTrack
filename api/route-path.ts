/**
 * GET /api/route-path?routeId=181&lat=24.8&lng=120.9
 * Returns a calm polyline for the map (local corridor preferred).
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getRoutePathForMap } from "../src/services/truck.service.js";

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");

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

  const lat = req.query.lat !== undefined ? parseFloat(String(req.query.lat)) : undefined;
  const lng = req.query.lng !== undefined ? parseFloat(String(req.query.lng)) : undefined;
  const routeName =
    typeof req.query.routeName === "string" ? req.query.routeName : undefined;

  try {
    const path = await getRoutePathForMap(routeId, {
      nearLat: Number.isFinite(lat) ? lat : undefined,
      nearLng: Number.isFinite(lng) ? lng : undefined,
      routeName,
    });
    res.status(200).json({
      ...path,
      tip: "藍線＝垃圾車會經過的路。很多路段是沿路收，往線附近等即可，不一定要站在旗子清運點。",
    });
  } catch (err) {
    console.error("[route-path]", err);
    res.status(500).json({ error: "failed to load route path" });
  }
}
