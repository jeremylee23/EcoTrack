/**
 * scripts/setup-rich-menu.ts
 * Rebuilds the default LINE Rich Menu as a 6-cell senior-friendly grid.
 *
 * Layout (2500×843):
 *  [ 📍定位 ] [ 🚛垃圾車 ] [ 📅班表 ]
 *  [ ⭐最愛 ] [ 🗺️附近   ] [ 📖說明 ]
 *
 * Run: npx tsx scripts/setup-rich-menu.ts
 */

import { messagingApi } from "@line/bot-sdk";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { config } from "dotenv";

config();

const client = new messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || "",
});

const clientBlob = new messagingApi.MessagingApiBlobClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || "",
});

const W = 2500;
const H = 843;
const COL_W = [833, 834, 833] as const;
const ROW_H = [421, 422] as const;
type MenuIcon = "location" | "truck" | "calendar" | "star" | "map" | "book";

function cellX(col: number): number {
  return COL_W.slice(0, col).reduce((a, b) => a + b, 0);
}

function cellY(row: number): number {
  return ROW_H.slice(0, row).reduce((a, b) => a + b, 0);
}

function renderIcon(icon: MenuIcon, cx: number, cy: number, color: string): string {
  switch (icon) {
    case "location":
      return `
        <g transform="translate(${cx} ${cy})" fill="none" stroke="${color}" stroke-width="9" stroke-linecap="round" stroke-linejoin="round">
          <path d="M0 -42 C-24 -42 -42 -24 -42 0 C-42 30 0 68 0 68 C0 68 42 30 42 0 C42 -24 24 -42 0 -42 Z"/>
          <circle cx="0" cy="0" r="14" fill="${color}" stroke="none"/>
        </g>
      `;
    case "truck":
      return `
        <g transform="translate(${cx} ${cy})" fill="none" stroke="${color}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round">
          <rect x="-48" y="-22" width="58" height="36" rx="6"/>
          <path d="M10 -10 H34 L48 6 V14 H10 Z"/>
          <line x1="34" y1="-10" x2="34" y2="6"/>
          <circle cx="-24" cy="24" r="8" fill="${color}" stroke="none"/>
          <circle cx="24" cy="24" r="8" fill="${color}" stroke="none"/>
          <line x1="-8" y1="24" x2="8" y2="24"/>
        </g>
      `;
    case "calendar":
      return `
        <g transform="translate(${cx} ${cy})" fill="none" stroke="${color}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round">
          <rect x="-42" y="-34" width="84" height="72" rx="12"/>
          <line x1="-42" y1="-8" x2="42" y2="-8"/>
          <line x1="-18" y1="-46" x2="-18" y2="-20"/>
          <line x1="18" y1="-46" x2="18" y2="-20"/>
          <circle cx="-16" cy="14" r="5" fill="${color}" stroke="none"/>
          <circle cx="0" cy="14" r="5" fill="${color}" stroke="none"/>
          <circle cx="16" cy="14" r="5" fill="${color}" stroke="none"/>
        </g>
      `;
    case "star":
      return `
        <g transform="translate(${cx} ${cy})" fill="${color}">
          <path d="M0 -48 L13 -14 L50 -14 L20 8 L31 44 L0 23 L-31 44 L-20 8 L-50 -14 L-13 -14 Z"/>
        </g>
      `;
    case "map":
      return `
        <g transform="translate(${cx} ${cy})" fill="none" stroke="${color}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M-44 -30 L-14 -40 L14 -20 L44 -30 V30 L14 40 L-14 20 L-44 30 Z"/>
          <line x1="-14" y1="-40" x2="-14" y2="20"/>
          <line x1="14" y1="-20" x2="14" y2="40"/>
          <circle cx="0" cy="4" r="8" fill="${color}" stroke="none"/>
        </g>
      `;
    case "book":
      return `
        <g transform="translate(${cx} ${cy})" fill="none" stroke="${color}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M-38 -30 H-4 C10 -30 20 -20 20 -6 V38 C10 30 2 26 -10 26 H-38 Z"/>
          <path d="M38 -30 H4 C-10 -30 -20 -20 -20 -6 V38 C-10 30 -2 26 10 26 H38 Z"/>
          <line x1="0" y1="-26" x2="0" y2="38"/>
        </g>
      `;
  }
}

async function createRichMenuImage(): Promise<string> {
  console.log("🎨 Generating 6-cell Rich Menu image...");

  // No emoji in SVG text — Pango on macOS crashes on color emoji fonts.
  // Use vector icons plus oversized labels so seniors can scan the menu quickly.
  const cells: Array<{
    col: number;
    row: number;
    title: string;
    icon: MenuIcon;
    bg: string;
    fg: string;
    iconBg: string;
    iconFg: string;
  }> = [
    {
      col: 0,
      row: 0,
      title: "定位",
      icon: "location",
      bg: "#ffffff",
      fg: "#111827",
      iconBg: "#2563eb",
      iconFg: "#ffffff",
    },
    {
      col: 1,
      row: 0,
      title: "垃圾車",
      icon: "truck",
      bg: "#059669",
      fg: "#ffffff",
      iconBg: "#ffffff",
      iconFg: "#059669",
    },
    {
      col: 2,
      row: 0,
      title: "班表",
      icon: "calendar",
      bg: "#0f766e",
      fg: "#ffffff",
      iconBg: "#ffffff",
      iconFg: "#0f766e",
    },
    {
      col: 0,
      row: 1,
      title: "最愛",
      icon: "star",
      bg: "#fff7ed",
      fg: "#9a3412",
      iconBg: "#ea580c",
      iconFg: "#ffffff",
    },
    {
      col: 1,
      row: 1,
      title: "附近",
      icon: "map",
      bg: "#eff6ff",
      fg: "#1e40af",
      iconBg: "#2563eb",
      iconFg: "#ffffff",
    },
    {
      col: 2,
      row: 1,
      title: "說明",
      icon: "book",
      bg: "#f3f4f6",
      fg: "#374151",
      iconBg: "#4b5563",
      iconFg: "#ffffff",
    },
  ];

  const panels = cells
    .map((c) => {
      const x = cellX(c.col);
      const y = cellY(c.row);
      const w = COL_W[c.col];
      const h = ROW_H[c.row];
      const pad = 14;
      const cx = x + w / 2;
      const cy = y + h / 2;
      const iconY = cy - 88;
      const textY = cy + 108;
      return `
        <rect x="${x + pad}" y="${y + pad}" width="${w - pad * 2}" height="${h - pad * 2}"
              rx="28" fill="${c.bg}" />
        <circle cx="${cx}" cy="${iconY}" r="86" fill="${c.iconBg}" />
        ${renderIcon(c.icon, cx, iconY, c.iconFg)}
        <text x="${cx}" y="${textY}" font-family="PingFang TC, Heiti TC, sans-serif"
          font-size="146" font-weight="800" fill="${c.fg}" text-anchor="middle" dominant-baseline="middle">${c.title}</text>
      `;
    })
    .join("\n");

  const svg = `
    <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${W}" height="${H}" fill="#e5e7eb" />
      <!-- grid lines -->
      <line x1="${COL_W[0]}" y1="0" x2="${COL_W[0]}" y2="${H}" stroke="#d1d5db" stroke-width="2"/>
      <line x1="${COL_W[0] + COL_W[1]}" y1="0" x2="${COL_W[0] + COL_W[1]}" y2="${H}" stroke="#d1d5db" stroke-width="2"/>
      <line x1="0" y1="${ROW_H[0]}" x2="${W}" y2="${ROW_H[0]}" stroke="#d1d5db" stroke-width="2"/>
      ${panels}
    </svg>
  `;

  const outputPath = path.resolve(__dirname, "rich-menu.png");
  await sharp(Buffer.from(svg)).png().toFile(outputPath);
  console.log("✅ Image generated at:", outputPath);
  return outputPath;
}

async function setupRichMenu(): Promise<void> {
  try {
    if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) {
      throw new Error("Missing LINE_CHANNEL_ACCESS_TOKEN in .env");
    }

    const imagePath = await createRichMenuImage();

    console.log("🗑️ Deleting old rich menus...");
    const oldMenus = await client.getRichMenuList();
    for (const menu of oldMenus.richmenus ?? []) {
      await client.deleteRichMenu(menu.richMenuId);
    }

    console.log("📝 Creating 6-cell rich menu...");
    const richMenu: messagingApi.RichMenuRequest = {
      size: { width: W, height: H },
      selected: true,
      name: "EcoTrack Main Menu v2",
      chatBarText: "選單",
      areas: [
        {
          bounds: { x: cellX(0), y: cellY(0), width: COL_W[0], height: ROW_H[0] },
          action: { type: "uri", uri: "https://line.me/R/nv/location/" },
        },
        {
          bounds: { x: cellX(1), y: cellY(0), width: COL_W[1], height: ROW_H[0] },
          action: { type: "message", text: "垃圾車" },
        },
        {
          bounds: { x: cellX(2), y: cellY(0), width: COL_W[2], height: ROW_H[0] },
          action: { type: "message", text: "班表" },
        },
        {
          bounds: { x: cellX(0), y: cellY(1), width: COL_W[0], height: ROW_H[1] },
          action: { type: "message", text: "最愛" },
        },
        {
          bounds: { x: cellX(1), y: cellY(1), width: COL_W[1], height: ROW_H[1] },
          action: { type: "message", text: "附近" },
        },
        {
          bounds: { x: cellX(2), y: cellY(1), width: COL_W[2], height: ROW_H[1] },
          action: { type: "message", text: "說明" },
        },
      ],
    };

    const response = await client.createRichMenu(richMenu);
    const richMenuId = response.richMenuId;
    console.log(`✅ Rich menu created! ID: ${richMenuId}`);

    console.log("📤 Uploading image...");
    const imageBuffer = fs.readFileSync(imagePath);
    const blob = new Blob([imageBuffer], { type: "image/png" });
    await clientBlob.setRichMenuImage(richMenuId, blob);
    console.log("✅ Image uploaded!");

    console.log("📌 Setting as default menu...");
    await client.setDefaultRichMenu(richMenuId);
    console.log("🎉 Done — 6-cell menu is now the default.");
  } catch (error: unknown) {
    const err = error as { response?: { data?: unknown }; message?: string };
    console.error("❌ Error setting up rich menu:", err?.response?.data || err.message || error);
    process.exitCode = 1;
  }
}

setupRichMenu();
