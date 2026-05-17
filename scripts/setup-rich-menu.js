const { messagingApi } = require("@line/bot-sdk");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

function getEnv() {
  const envFile = fs.readFileSync(".env", "utf8");
  const env = {};
  envFile.split("\n").forEach(line => {
    const parts = line.split("=");
    if (parts.length >= 2) {
      env[parts[0]] = parts.slice(1).join("=").replace(/"/g, '').trim();
    }
  });
  return env;
}

const env = getEnv();
const client = new messagingApi.MessagingApiClient({
  channelAccessToken: env.LINE_CHANNEL_ACCESS_TOKEN,
});

const clientBlob = new messagingApi.MessagingApiBlobClient({
  channelAccessToken: env.LINE_CHANNEL_ACCESS_TOKEN,
});

async function createRichMenuImage() {
  console.log("🎨 Generating Rich Menu image...");
  const width = 2500;
  const height = 843;
  
  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg1" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#ffffff" />
          <stop offset="100%" stop-color="#f0f0f0" />
        </linearGradient>
        <linearGradient id="bg2" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#10b981" />
          <stop offset="100%" stop-color="#059669" />
        </linearGradient>
      </defs>
      
      <rect width="${width}" height="${height}" fill="#eaeaea" />
      
      <g transform="translate(50, 50)">
        <rect width="1150" height="743" rx="40" fill="url(#bg1)" />
        <text x="575" y="420" font-family="sans-serif" font-size="100" font-weight="bold" fill="#333" text-anchor="middle">📍 綁定住家位置</text>
        <text x="575" y="520" font-family="sans-serif" font-size="45" font-weight="normal" fill="#666" text-anchor="middle">接收垃圾車靠近通知</text>
      </g>
      
      <g transform="translate(1300, 50)">
        <rect width="1150" height="743" rx="40" fill="url(#bg2)" />
        <text x="575" y="420" font-family="sans-serif" font-size="100" font-weight="bold" fill="#fff" text-anchor="middle">🚛 查詢垃圾車 ETA</text>
        <text x="575" y="520" font-family="sans-serif" font-size="45" font-weight="normal" fill="#fff" text-anchor="middle">即時取得預估抵達時間</text>
      </g>
    </svg>
  `;

  const outputPath = path.resolve(__dirname, "rich-menu.png");
  await sharp(Buffer.from(svg)).png().toFile(outputPath);
  console.log("✅ Image generated at:", outputPath);
  return outputPath;
}

async function setupRichMenu() {
  try {
    const imagePath = await createRichMenuImage();

    console.log("🗑️ Deleting old rich menus...");
    const oldMenus = await client.getRichMenuList();
    for (const menu of oldMenus.richmenus) {
      await client.deleteRichMenu(menu.richMenuId);
    }

    console.log("📝 Creating new rich menu...");
    const richMenu = {
      size: { width: 2500, height: 843 },
      selected: true,
      name: "EcoTrack Main Menu",
      chatBarText: "開啟快速選單",
      areas: [
        {
          bounds: { x: 0, y: 0, width: 1250, height: 843 },
          action: { type: "uri", uri: "line://nv/location" }
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
    
  } catch (error) {
    console.error("❌ Error setting up rich menu:", error.message || error);
  }
}

setupRichMenu();
