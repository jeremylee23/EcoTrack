import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from "@supabase/supabase-js";
import { config } from "../config/index.js";

const genAI = new GoogleGenerativeAI(config.gemini.apiKey);
const supabase = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
  auth: { persistSession: false },
});

export type Intent = "eta" | "rag" | "help" | "unknown";

/**
 * 透過 Gemini 判斷使用者的意圖。
 * 若文字過短或明顯是查詢指令，可以直接用簡單的 if 判斷加速，這裡我們交給 LLM 全權判斷。
 */
export async function classifyIntent(text: string): Promise<Intent> {
  // 如果字數非常少且包含常見關鍵字，直接回傳 eta 節省時間
  if (text.length <= 4 && /垃圾車|在哪|幾點|到了/.test(text)) {
    return "eta";
  }

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const prompt = `
你是一個新竹市垃圾車客服系統的意圖分類器。
使用者會傳送一句話，請你判斷這句話的意圖，只能回傳以下其中一個單字：
- "eta": 使用者想查詢垃圾車什麼時候來、目前在哪裡、或是傳送短短的「垃圾車」三個字。
- "help": 使用者想知道怎麼使用這個系統、或是說「你好」、「幫助」。
- "rag": 使用者詢問系統相關問題，例如「為什麼垃圾車沒來」、「GPS 閒置是什麼意思」、「可以倒廚餘嗎」等一般性問題。
- "unknown": 毫無意義或無法分類的話。

使用者訊息：
"${text}"
`;

    const result = await model.generateContent(prompt);
    const response = result.response.text().trim().toLowerCase();

    if (response.includes("eta")) return "eta";
    if (response.includes("rag")) return "rag";
    if (response.includes("help")) return "help";
    return "unknown";
  } catch (error) {
    console.error("[RAG] classifyIntent error:", error);
    return "eta"; // 發生錯誤時退回預設的 eta 行為
  }
}

/**
 * 將文字轉成向量
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const model = genAI.getGenerativeModel({ model: "gemini-embedding-2" });
  const result = await model.embedContent(text);
  const embedding = result.embedding;
  if (!embedding || !embedding.values) {
    throw new Error("Failed to generate embedding");
  }
  return embedding.values;
}

/**
 * RAG 核心：檢索知識庫並生成回覆
 */
export async function generateRagResponse(query: string): Promise<string> {
  try {
    // 1. 將問題轉為向量
    const embedding = await generateEmbedding(query);

    // 2. 檢索知識庫
    const { data, error } = await supabase.rpc("search_knowledge", {
      query_embedding: embedding,
      match_count: 3,
      source_filter: "docs",
    });

    if (error) {
      console.error("[RAG] Supabase search error:", error);
      throw error;
    }

    let contextText = "無相關背景知識。";
    if (data && data.length > 0) {
      contextText = data
        .map((doc: any) => `【${doc.title}】\n${doc.content}`)
        .join("\n\n");
    }

    // 3. 組裝 Prompt 並呼叫 Gemini 進行生成
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const prompt = `
你是「新竹市垃圾車追蹤系統」的客服小幫手，請溫柔親切地回答民眾的問題。
如果提供的背景知識中沒有答案，請婉轉地告知民眾你目前還不知道，或建議他們聯絡新竹市環保局 (03-536-8920)。
請以繁體中文回答，可以直接使用 Emoji 增加親切感。

【背景知識】：
${contextText}

【民眾的問題】：
${query}
`;

    const result = await model.generateContent(prompt);
    return result.response.text().trim();
  } catch (error) {
    console.error("[RAG] generateRagResponse error:", error);
    return "抱歉，系統目前處理您的問題時遇到一點困難，請稍後再試。若有緊急狀況可聯絡新竹市環保局 (03-536-8920)。";
  }
}
