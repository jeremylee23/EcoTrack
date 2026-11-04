const fs = require('fs');
const { Client } = require('pg');
require('dotenv').config();

async function run() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('Missing DATABASE_URL');
    process.exit(1);
  }
  const client = new Client(connectionString);
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
