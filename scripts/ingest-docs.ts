import { GoogleGenerativeAI } from '@google/generative-ai';
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';
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

async function ingestDocs() {
  const docsDir = path.join(__dirname, '../docs');
  const files = fs.readdirSync(docsDir).filter(f => f.endsWith('.md'));

  for (const file of files) {
    if (file === 'rag-setup.sql') continue;

    console.log(`Processing ${file}...`);
    const content = fs.readFileSync(path.join(docsDir, file), 'utf-8');
    
    // Simple chunking strategy: split by markdown headings
    // Or just insert the whole file if it's small enough.
    // For our docs, they are relatively small, but let's chunk by '## '
    const chunks = content.split('\n## ').filter(c => c.trim().length > 0);
    
    for (let i = 0; i < chunks.length; i++) {
      let chunkText = chunks[i];
      if (i > 0) chunkText = '## ' + chunkText; // restore heading for context
      
      const titleMatch = chunkText.match(/^(?:#|##)\s+(.*)/);
      const title = titleMatch ? titleMatch[1] : file;

      try {
        const embedding = await generateEmbedding(chunkText);
        
        const { error } = await supabase.from('knowledge_base').insert({
          source: 'docs',
          title: title,
          content: chunkText,
          embedding: embedding,
          metadata: { file, chunk_index: i }
        });

        if (error) {
          console.error(`Error inserting chunk from ${file}:`, error.message);
        } else {
          console.log(`  ✓ Inserted chunk: ${title}`);
        }
      } catch (e) {
        console.error(`Error generating embedding for ${file}:`, e);
      }
    }
  }
  console.log("Ingestion complete.");
}

ingestDocs().catch(console.error);
