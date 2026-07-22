/**
 * scripts/setup-rich-menu.ts
 * Rebuilds the default LINE Rich Menu as a 6-cell UX grid.
 *
 * Layout (2500×843):
 *  [ 📍定位 ] [ 🚛垃圾車 ] [ 📅班表 ]
 *  [ ⭐最愛 ] [ 🔍搜尋   ] [ 📖說明 ]
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

function cellX(col: number): number {
  return COL_W.slice(0, col).reduce((a, b) => a + b, 0);
}

function cellY(row: number): number {
  return ROW_H.slice(0, row).reduce((a, b) => a + b, 0);
}

async function createRichMenuImage(): Promise<string> {
  console.log("🎨 Generating 6-cell Rich Menu image...");

  const cells: Array<{
    col: number;
    row: number;
    title: string;
    subtitle: string;
    bg: string;
    fg: string;
    subFg: string;
  }> = [
    {
      col: 0,
      row: 0,
      title: "📍 定位",
      subtitle: "綁定住家",
      bg: "#ffffff",
      fg: "#111827",
      subFg: "#6b7280",
    },
    {
      col: 1,
      row: 0,
      title: "🚛 垃圾車",
      subtitle: "即時 ETA",
      bg: "#059669",
      fg: "#ffffff",
      subFg: "#d1fae5",
    },
    {
      col: 2,
      row: 0,
      title: "📅 班表",
      subtitle: "本週清運",
      bg: "#0f766e",
      fg: "#ffffff",
      subFg: "#ccfbf1",
    },
    {
      col: 0,
      row: 1,
      title: "⭐ 最愛",
      subtitle: "多點切換",
      bg: "#fff7ed",
      fg: "#9a3412",
      subFg: "#c2410c",
    },
    {
      col: 1,
      row: 1,
      title: "🔍 搜尋",
      subtitle: "路名／地標",
      bg: "#eff6ff",
      fg: "#1e40af",
      subFg: "#3b82f6",
    },
    {
      col: 2,
      row: 1,
      title: "📖 說明",
      subtitle: "怎麼用",
      bg: "#f3f4f6",
      fg: "#374151",
      subFg: "#6b7280",
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
      return `
        <rect x="${x + pad}" y="${y + pad}" width="${w - pad * 2}" height="${h - pad * 2}"
              rx="28" fill="${c.bg}" />
        <text x="${cx}" y="${cy - 8}" font-family="Helvetica Neue, Arial, sans-serif"
              font-size="88" font-weight="700" fill="${c.fg}" text-anchor="middle">${c.title}</text>
        <text x="${cx}" y="${cy + 72}" font-family="Helvetica Neue, Arial, sans-serif"
              font-size="44" font-weight="600" fill="${c.subFg}" text-anchor="middle">${c.subtitle}</text>
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
          action: { type: "message", text: "搜尋" },
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
