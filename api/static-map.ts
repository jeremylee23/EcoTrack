/**
 * GET /api/static-map?lat=24.8&lng=120.9&z=16
 * PNG map preview (for LINE Flex hero) — seniors see a pin, not only words.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import sharp from "sharp";

const TILE = 256;
const OUT_W = 800;
const OUT_H = 420;
const UA =
  "EcoTrack/1.0 (https://ecotrack-hsinchu.vercel.app; LINE Bot map preview)";

function latLngToWorld(
  lat: number,
  lng: number,
  zoom: number
): { x: number; y: number; n: number } {
  const n = 2 ** zoom;
  const x = ((lng + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const y =
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
    n;
  return { x, y, n };
}

async function fetchTile(
  z: number,
  x: number,
  y: number
): Promise<Buffer> {
  const url = `https://a.basemaps.cartocdn.com/rastertiles/voyager/${z}/${x}/${y}.png`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) {
    throw new Error(`tile ${z}/${x}/${y} failed: ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

function pinSvg(): Buffer {
  return Buffer.from(`
    <svg width="48" height="64" xmlns="http://www.w3.org/2000/svg">
      <path d="M24 2 C12 2 4 12 4 24 C4 40 24 62 24 62 C24 62 44 40 44 24 C44 12 36 2 24 2 Z"
            fill="#dc2626" stroke="#ffffff" stroke-width="3"/>
      <circle cx="24" cy="24" r="8" fill="#ffffff"/>
    </svg>
  `);
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader(
    "Cache-Control",
    "public, s-maxage=86400, stale-while-revalidate=604800"
  );

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "GET") {
    res.status(405).json({ error: "Method Not Allowed" });
    return;
  }

  const lat = parseFloat(String(req.query.lat ?? ""));
  const lng = parseFloat(String(req.query.lng ?? ""));
  const zoomRaw = parseInt(String(req.query.z ?? "16"), 10);
  const zoom = Number.isFinite(zoomRaw)
    ? Math.min(18, Math.max(12, zoomRaw))
    : 16;

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    res.status(400).json({ error: "lat and lng required" });
    return;
  }
  if (lat < -85 || lat > 85 || lng < -180 || lng > 180) {
    res.status(400).json({ error: "lat/lng out of range" });
    return;
  }

  try {
    const { x: wx, y: wy, n } = latLngToWorld(lat, lng, zoom);
    const centerPx = wx * TILE;
    const centerPy = wy * TILE;
    const left = centerPx - OUT_W / 2;
    const top = centerPy - OUT_H / 2;

    const x0 = Math.floor(left / TILE);
    const y0 = Math.floor(top / TILE);
    const x1 = Math.floor((left + OUT_W - 1) / TILE);
    const y1 = Math.floor((top + OUT_H - 1) / TILE);

    const jobs: Array<Promise<{ input: Buffer; left: number; top: number }>> =
      [];
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        if (tx < 0 || ty < 0 || tx >= n || ty >= n) continue;
        jobs.push(
          fetchTile(zoom, tx, ty).then((buf) => ({
            input: buf,
            left: Math.round(tx * TILE - left),
            top: Math.round(ty * TILE - top),
          }))
        );
      }
    }

    const tiles = await Promise.all(jobs);
    const png = await sharp({
      create: {
        width: OUT_W,
        height: OUT_H,
        channels: 4,
        background: { r: 226, g: 232, b: 240, alpha: 1 },
      },
    })
      .composite([
        ...tiles,
        {
          input: pinSvg(),
          left: Math.round(OUT_W / 2 - 24),
          top: Math.round(OUT_H / 2 - 56),
        },
      ])
      .png()
      .toBuffer();

    res.setHeader("Content-Type", "image/png");
    res.status(200).send(png);
  } catch (err) {
    console.error("[static-map]", err);
    res.status(500).json({ error: "failed to build map preview" });
  }
}
