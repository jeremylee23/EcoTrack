import { GoogleGenerativeAI } from '@google/generative-ai';
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function generateEmbedding(text: string): Promise<number[]> {
  const model = genAI.getGenerativeModel({ model: "gemini-embedding-2" });
  const result = await model.embedContent(text);
  const embedding = result.embedding;
  if (!embedding || !embedding.values) {
    throw new Error('Failed to generate embedding');
  }
  return embedding.values;
}

async function queryRag() {
  const query = process.argv[2] || "GPS 閒置的判斷邏輯是什麼？";
  console.log(`\n🔍 查詢問題: "${query}"\n`);

  try {
    const embedding = await generateEmbedding(query);
    
    // 呼叫 Supabase RPC 搜尋相似向量
    const { data, error } = await supabase.rpc('search_knowledge', {
      query_embedding: embedding,
      match_count: 3,
      source_filter: 'docs'
    });

    if (error) throw error;

    if (!data || data.length === 0) {
      console.log("⚠️ 找不到相關知識。");
      return;
    }

    console.log("📚 找到以下相關知識段落：\n");
    data.forEach((doc: any, i: number) => {
      console.log(`[${i + 1}] 來源檔案: ${doc.metadata.file} | 標題: ${doc.title}`);
      console.log(`相似度: ${(doc.similarity * 100).toFixed(2)}%\n`);
      console.log(doc.content.slice(0, 300) + (doc.content.length > 300 ? "...\n" : "\n"));
      console.log("-".repeat(40) + "\n");
    });
    
  } catch (err) {
    console.error("查詢失敗:", err);
  }
}

queryRag().catch(console.error);
