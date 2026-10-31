import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function runMigrations(db, log = console.log) {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const { rows } = await db.query('SELECT name FROM schema_migrations');
  const done = new Set(rows.map((r) => r.name));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    await db.tx(async (t) => {
      await t.exec(sql); // multi-statement, sem parâmetros
      await t.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
    });
    log(`migração aplicada: ${f}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { process.loadEnvFile(); } catch { /* sem .env */ }
  const { createDb } = await import('./db.js');
  const db = await createDb({ databaseUrl: process.env.DATABASE_URL, dataDir: process.env.PGLITE_DIR || './data/pglite' });
  await runMigrations(db);
  await db.close();
}
