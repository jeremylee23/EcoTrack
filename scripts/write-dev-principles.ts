import { createClient } from "@supabase/supabase-js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { config as loadEnv } from "dotenv";

loadEnv();

const db = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);
const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

async function embed(text: string): Promise<number[]> {
  const model = genai.getGenerativeModel({ model: "gemini-embedding-2" });
  const result = await model.embedContent(text);
  return result.embedding.values;
}

const entries = [
  {
    source: "internal",
    title: "EcoTrack 專案開發原則",
    content: `【總方針】安全可靠為主，新技術為輔。（制定日期：2026-05-20）

【版本控制 Gitflow】
- master 分支：永遠保持正式上線版本，Vercel 自動部署至 Production。
- develop 分支：日常開發、除錯都在此分支進行，Vercel 產生 Preview 連結。
- feature/* 或 fix/* 分支：新功能或重大修正從 develop 切出，完成後 PR 合併回 develop。
- 正式上線：develop → PR Review → 合併至 master → Vercel 自動部署。

【資安守則】
- 所有金鑰（API Key、Secret、Token）存放於 .env 或 Vercel Environment Variables，絕不寫死在程式碼。
- 每次 Git Commit 前，Husky pre-commit hook 執行 scripts/scan-secrets.js 自動掃描敏感資料，偵測到則阻擋 Commit。
- LINE Webhook 使用 HMAC-SHA256 + timingSafeEqual 驗證簽名，防止偽造請求與 timing attack。
- Cron Job 端點使用 Bearer Token (CRON_SECRET) 防止未授權呼叫。
- .env 已加入 .gitignore，不會被推送至 GitHub。

【程式碼品質】
- 使用 TypeScript，所有 API 回傳值需明確型別定義，禁止濫用 any。
- 部署前使用 npx tsc --noEmit 確認型別正確。
- 環境變數透過 src/config/index.ts 統一管理，缺少必要變數時在啟動時快速失敗（fail fast）。
- 遵循 Conventional Commits 格式：feat: / fix: / chore: / docs: 等。

【部署規範】
- 使用 npm run ship "commit message" 統一部署。
- 暫存測試檔案須在 Commit 前清除，並加入 .gitignore。

【RAG 知識庫管理】
- 知識庫須經人工審核後才能寫入，不接受使用者輸入直接寫入。
- 使用 upsert 更新，防止新舊資料並存造成 AI 回答矛盾。
- 每筆資料需標記 source、metadata（含 category、updated_at）。`,
    metadata: { category: "開發規範", updated_at: new Date().toISOString() },
  },
  {
    source: "internal",
    title: "EcoTrack 資安審查報告 2026-05-20",
    content: `【已保護項目】✅
- LINE Webhook：HMAC-SHA256 + crypto.timingSafeEqual 防偽造與 timing attack。
- Cron Job：Authorization Bearer Token 防未授權觸發。
- 環境變數：統一由 src/config/index.ts 讀取，缺少即啟動失敗。
- Git Commit 掃描：Husky pre-commit 阻擋含密鑰的 Commit。
- .gitignore：.env、node_modules、*.log、test_*.ts 均不提交。
- Supabase Service Role Key：僅在伺服器端使用。

【已修復問題】🔧
- test_db.ts 曾將 DB 連線字串寫死 → 被 pre-commit hook 阻擋並刪除。
- test_eta.ts、test_gemini.ts、vercel_deploy.log、xiangshan_stops.json、test.png 殘留根目錄 → 已清除並加入 .gitignore。

【已知風險與待處理】⚠️
- npm 套件漏洞：undici 存在 6 個 high 漏洞（HTTP smuggling、DoS），smol-toml 有 3 個 moderate 漏洞。修復需升級 @vercel/node 至 v4.0.0（Breaking Change），需在 develop 分支測試後合併。
- /api/health 端點無需認證（低風險，僅回傳 alive 狀態），暫時保留。
- HCCG 市政府 API 無金鑰，高頻呼叫可能被封鎖，已透過 Redis 快取 5 分鐘降低呼叫頻率。

【建議後續強化】💡
- 升級 @vercel/node 至 v4.0.0 解決 undici 漏洞。
- 加入 Upstash Rate Limiting 防止 Webhook 濫用。
- 為 /api/health 加入版本資訊供監控使用。`,
    metadata: { category: "資安審查", updated_at: new Date().toISOString() },
  },
  {
    source: "internal",
    title: "EcoTrack RAG 知識庫管理原則",
    content: `【寫入原則】
- 知識庫資料必須經過人工審核才能正式寫入。
- 絕不將使用者聊天紀錄直接寫入，防止資料污染與 AI 幻覺。
- 使用 upsert 更新（以 title 為唯一鍵），同一主題永遠只保留最新版本。

【防矛盾機制】
- 每筆資料在 metadata 中標記 updated_at 與 category。
- Gemini 的 System Prompt 指示：「若遇到矛盾，以 updated_at 最新的資料為準」。
- 重大政策變更時，先刪除舊資料或直接覆寫。

【分類標準（category）】
- 開發規範：專案開發準則、GitFlow、部署規範。
- 資安審查：資安稽核報告、已知風險、修復紀錄。
- 垃圾清運：垃圾分類、收運時間、清運規定。
- 資源回收：資源回收分類、回收日期、回收方式。
- 大型廢棄物：預約清運規定與聯絡資訊。
- 系統說明：EcoTrack Bot 使用說明與功能介紹。

【向量搜尋設定】
- 模型：Google text-embedding-004（768 維）。
- 相似度閾值：0.7（低於此值不採用）。
- 每次最多取回 3 筆最相關資料作為 Context。`,
    metadata: { category: "開發規範", updated_at: new Date().toISOString() },
  },
];

async function main() {
  process.stdout.write(`Writing ${entries.length} entries to knowledge_base...\n`);

  for (const entry of entries) {
    const fullText = `${entry.title}\n\n${entry.content}`;
    process.stdout.write(`  Embedding: "${entry.title}"...\n`);
    const embedding = await embed(fullText);

    // Delete existing entry with same title first (manual upsert since no unique constraint)
    await db.from("knowledge_base").delete().eq("title", entry.title);

    const { error } = await db.from("knowledge_base").insert({
      source: entry.source,
      title: entry.title,
      content: entry.content,
      embedding,
      metadata: entry.metadata,
    });

    if (error) {
      process.stdout.write(`  ❌ Failed: ${error.message}\n`);
    } else {
      process.stdout.write(`  ✅ Done\n`);
    }
  }

  process.stdout.write("\n✅ All entries written to knowledge_base!\n");
}

main().catch(e => { process.stdout.write(String(e) + "\n"); });
