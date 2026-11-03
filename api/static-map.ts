/**
 * GET /api/static-map?lat=24.8&lng=120.9&z=16
 * PNG map preview (for LINE Flex hero) — seniors see a pin, not only words.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import sharp from "sharp";
import {
  applyCors,
  ensureMethod,
  handleOptions,
  sendError,
} from "../src/utils/api-handler.util.js";

const TILE = 256;
const OUT_W = 800;
const OUT_H = 420;
const UA =
  "EcoTrack/1.0 (https://ecotrack-hsinchu.vercel.app; LINE Bot map preview)";
/** OSM tile usage policy asks caches to retain tiles at least 7 days. */
const TILE_CACHE_SECONDS = 7 * 24 * 60 * 60;

/**
 * CARTO Voyager (`*.basemaps.cartocdn.com/rastertiles/voyager`) now responds
 * HTTP 200 with an "API KEY REQUIRED" watermark PNG. These standard OSM
 * raster tiles need no key and are allowed for this low-traffic preview
 * when https://operations.osmfoundation.org/policies/tiles/ is followed:
 * exact host, identifying User-Agent, Referer, and a visible credit.
 */
function osmTileUrl(z: number, x: number, y: number): string {
  return `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
}

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
  const url = osmTileUrl(z, x, y);
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Referer: "https://ecotrack-hsinchu.vercel.app/",
      Accept: "image/png",
    },
  });
  const contentType = res.headers.get("content-type") ?? "";
  if (!res.ok || !contentType.includes("image/")) {
    throw new Error(
      `tile ${z}/${x}/${y} failed: ${res.status} ${contentType || "no content-type"}`
    );
  }
  return Buffer.from(await res.arrayBuffer());
}

/** LINE Flex shows this PNG with no Leaflet credit, so bake the licence in. */
function attributionSvg(): Buffer {
  return Buffer.from(`
    <svg width="${OUT_W}" height="${OUT_H}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="${OUT_H - 28}" width="${OUT_W}" height="28" fill="rgba(255,255,255,0.9)"/>
      <text x="16" y="${OUT_H - 9}" font-family="DejaVu Sans, Liberation Sans, Nimbus Sans, sans-serif" font-size="15" fill="#1f2937">&#169; OpenStreetMap contributors</text>
    </svg>
  `);
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
  applyCors(res, ["GET"]);
  res.setHeader(
    "Cache-Control",
    `public, s-maxage=${TILE_CACHE_SECONDS}, stale-while-revalidate=${TILE_CACHE_SECONDS}`
  );

  if (handleOptions(req, res)) return;

  if (!ensureMethod(req, res, ["GET"])) return;

  const lat = parseFloat(String(req.query.lat ?? ""));
  const lng = parseFloat(String(req.query.lng ?? ""));
  const zoomRaw = parseInt(String(req.query.z ?? "16"), 10);
  const zoom = Number.isFinite(zoomRaw)
    ? Math.min(18, Math.max(12, zoomRaw))
    : 16;

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    sendError(res, 400, "LAT_LNG_REQUIRED", "lat and lng required");
    return;
  }
  if (lat < -85 || lat > 85 || lng < -180 || lng > 180) {
    sendError(res, 400, "LAT_LNG_OUT_OF_RANGE", "lat/lng out of range");
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
        { input: attributionSvg(), left: 0, top: 0 },
      ])
      .png()
      .toBuffer();

    res.setHeader("Content-Type", "image/png");
    res.status(200).send(png);
  } catch (err) {
    console.error("[static-map]", err);
    sendError(
      res,
      500,
      "STATIC_MAP_BUILD_FAILED",
      "failed to build map preview"
    );
  }
}
