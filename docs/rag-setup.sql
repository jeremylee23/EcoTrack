-- 1. 啟用 pgvector 擴充模組
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. 建立 knowledge_base 資料表，儲存文本與向量 (Gemini 輸出 768 維度)
CREATE TABLE IF NOT EXISTS knowledge_base (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text,
  title text,
  content text,
  embedding vector(768),
  metadata jsonb,
  created_at timestamptz DEFAULT now()
);

-- 3. 建立搜尋用的 RPC 函數 (Cosine Similarity)
CREATE OR REPLACE FUNCTION search_knowledge(
  query_embedding vector(768),
  match_count int DEFAULT 5,
  source_filter text DEFAULT null
)
RETURNS TABLE (
  id uuid, title text, content text, source text,
  metadata jsonb, similarity float
)
LANGUAGE sql STABLE AS $$
  SELECT id, title, content, source, metadata,
         1 - (embedding <=> query_embedding) AS similarity
  FROM knowledge_base
  WHERE (source_filter IS NULL OR source = source_filter)
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;
