const { Client } = require('pg');

const connectionString = 'process.env.SUPABASE_DB_URL';

async function setupDatabase() {
  const client = new Client({ connectionString });
  
  try {
    console.log("Connecting to Supabase PostgreSQL...");
    await client.connect();
    
    console.log("Enabling pgvector extension...");
    await client.query('CREATE EXTENSION IF NOT EXISTS vector;');
    
    console.log("Creating knowledge_base table...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS knowledge_base (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        source text,
        title text,
        content text,
        embedding vector(768),
        metadata jsonb,
        created_at timestamptz DEFAULT now()
      );
    `);
    
    console.log("Creating search_knowledge RPC function...");
    await client.query(`
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
    `);

    console.log("Database setup completed successfully!");
  } catch (error) {
    console.error("Database setup failed:", error);
  } finally {
    await client.end();
  }
}

setupDatabase();
