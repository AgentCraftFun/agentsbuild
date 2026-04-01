#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname);

async function run() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('ERROR: DATABASE_URL environment variable is not set.');
    process.exit(1);
  }

  const client = new Client({ connectionString: databaseUrl });

  try {
    console.log('Connecting to database...');
    await client.connect();
    console.log('Connected.\n');

    // Ensure migrations tracking table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        filename VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Get already-applied migrations
    const { rows: applied } = await client.query(
      'SELECT filename FROM _migrations ORDER BY filename'
    );
    const appliedSet = new Set(applied.map((r) => r.filename));

    // Read all .sql files from the migrations directory, sorted
    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    if (files.length === 0) {
      console.log('No migration files found.');
      process.exit(0);
    }

    let ranCount = 0;

    for (const file of files) {
      if (appliedSet.has(file)) {
        console.log(`  SKIP  ${file} (already applied)`);
        continue;
      }

      const filePath = path.join(MIGRATIONS_DIR, file);
      const sql = fs.readFileSync(filePath, 'utf-8');

      console.log(`  RUN   ${file} ...`);
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          'INSERT INTO _migrations (filename) VALUES ($1)',
          [file]
        );
        await client.query('COMMIT');
        console.log(`  OK    ${file}`);
        ranCount++;
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`  FAIL  ${file}`);
        console.error(`        ${err.message}`);
        process.exit(1);
      }
    }

    console.log(
      `\nDone. ${ranCount} migration(s) applied, ${files.length - ranCount} skipped.`
    );
  } catch (err) {
    console.error('Migration runner failed:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();
