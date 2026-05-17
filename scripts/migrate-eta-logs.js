const fs = require('fs');
const { Client } = require('pg');

async function run() {
  const client = new Client("postgresql://postgres:3z3g6ZVpeLOBFR8f@db.xsytkncomjcypfesxsbw.supabase.co:5432/postgres");
  try {
    await client.connect();
    const sql = fs.readFileSync('supabase/migrations/002_eta_logs.sql', 'utf8');
    await client.query(sql);
    console.log('✅ Migration 002 applied successfully.');
  } catch(e) {
    console.error('Error:', e);
  } finally {
    await client.end();
  }
}
run();
