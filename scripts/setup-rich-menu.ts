import { messagingApi } from "@line/bot-sdk";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { config } from "dotenv";

// Load environment variables
config();

const client = new messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || "",
});

const clientBlob = new messagingApi.MessagingApiBlobClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || "",
});

async function createRichMenuImage() {
  console.log("🎨 Generating Rich Menu image...");
  
  const width = 2500;
  const height = 843;
  
  // Create an SVG with two large distinct buttons
  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg1" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#fdfbfb" />
          <stop offset="100%" stop-color="#ebedee" />
        </linearGradient>
        <linearGradient id="bg2" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#e0c3fc" />
          <stop offset="100%" stop-color="#8ec5fc" />
        </linearGradient>
        <filter id="shadow" x="-5%" y="-5%" width="110%" height="110%">
          <feDropShadow dx="0" dy="10" stdDeviation="15" flood-color="#000000" flood-opacity="0.1"/>
        </filter>
      </defs>
      
      <!-- Background -->
      <rect width="${width}" height="${height}" fill="#f4f7f6" />
      
      <!-- Button 1 (Left) -->
      <g transform="translate(50, 50)">
        <rect width="1150" height="743" rx="40" fill="url(#bg1)" filter="url(#shadow)" />
        <text x="575" y="420" font-family="sans-serif" font-size="100" font-weight="bold" fill="#333" text-anchor="middle">📍 綁定住家位置</text>
        <text x="575" y="520" font-family="sans-serif" font-size="45" font-weight="normal" fill="#666" text-anchor="middle">接收垃圾車靠近通知</text>
      </g>
      
      <!-- Button 2 (Right) -->
      <g transform="translate(1300, 50)">
        <rect width="1150" height="743" rx="40" fill="url(#bg2)" filter="url(#shadow)" />
        <text x="575" y="420" font-family="sans-serif" font-size="100" font-weight="bold" fill="#fff" text-anchor="middle">🚛 查詢垃圾車 ETA</text>
        <text x="575" y="520" font-family="sans-serif" font-size="45" font-weight="normal" fill="#fff" text-anchor="middle">即時取得預估抵達時間</text>
      </g>
    </svg>
  `;

  const outputPath = path.resolve(__dirname, "rich-menu.png");
  
  await sharp(Buffer.from(svg))
    .png()
    .toFile(outputPath);
    
  console.log("✅ Image generated at:", outputPath);
  return outputPath;
}

async function setupRichMenu() {
  try {
    const imagePath = await createRichMenuImage();

    console.log("🗑️ Deleting old rich menus...");
    const oldMenus = await client.getRichMenuList();
    for (const menu of oldMenus) {
      await client.deleteRichMenu(menu.richMenuId);
    }

    console.log("📝 Creating new rich menu...");
    const richMenu: messagingApi.RichMenuRequest = {
      size: { width: 2500, height: 843 },
      selected: true,
      name: "EcoTrack Main Menu",
      chatBarText: "選單",
      areas: [
        {
          bounds: { x: 0, y: 0, width: 1250, height: 843 },
          action: { type: "uri", uri: "line://nv/location" } // Opens LINE's location picker
        },
        {
          bounds: { x: 1250, y: 0, width: 1250, height: 843 },
          action: { type: "message", text: "垃圾車在哪" }
        }
      ]
    };

    const response = await client.createRichMenu(richMenu);
    const richMenuId = response.richMenuId;
    console.log(`✅ Rich menu created! ID: ${richMenuId}`);

    console.log("📤 Uploading image...");
    const imageBuffer = fs.readFileSync(imagePath);
    const blob = new Blob([imageBuffer], { type: 'image/png' });
    await clientBlob.setRichMenuImage(richMenuId, blob);
    console.log("✅ Image uploaded!");

    console.log("📌 Setting as default menu...");
    await client.setDefaultRichMenu(richMenuId);
    console.log("🎉 All done! The rich menu is now active.");
    
  } catch (error: any) {
    console.error("❌ Error setting up rich menu:", error?.response?.data || error.message);
  }
}

setupRichMenu();
