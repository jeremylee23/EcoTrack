-- 1. 更新資料表欄位維度為 3072 (Gemini-embedding-2 的規格)
ALTER TABLE knowledge_base ALTER COLUMN embedding TYPE vector(3072);

-- 2. 更新 RPC 函數維度
DROP FUNCTION IF EXISTS search_knowledge(vector(768), int, text);
CREATE OR REPLACE FUNCTION search_knowledge(
  query_embedding vector(3072),
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
