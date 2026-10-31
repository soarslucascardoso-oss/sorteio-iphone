// Restaura um backup JSON em um banco VAZIO (após rodar as migrações).
// Uso: DATABASE_URL=... npm run restore -- backups/arquivo.json --confirm
try { process.loadEnvFile(); } catch { /* sem .env */ }
import fs from 'node:fs';
import { createDb } from '../server/db.js';
import { runMigrations } from '../server/migrate.js';
import { TABLES } from './backup.js';

export async function restoreDump(db, dump) {
  if (dump?.format !== 'sorteio-backup' || dump.version !== 1) throw new Error('Arquivo de backup inválido.');
  await runMigrations(db, () => {});
  const { rows: [c] } = await db.query('SELECT COUNT(*)::int AS n FROM entries');
  if (c.n > 0) throw new Error('O banco de destino já tem inscrições. Restaure em um banco vazio.');
  await db.tx(async (t) => {
    await t.query('DELETE FROM draws'); await t.query('DELETE FROM audit_log'); await t.query('DELETE FROM settings');
    for (const table of ['settings', 'entries', 'draws', 'audit_log']) {
      for (const row of dump.tables[table] || []) {
        const cols = Object.keys(row);
        const vals = cols.map((k) => (row[k] !== null && typeof row[k] === 'object' ? JSON.stringify(row[k]) : row[k]));
        const ph = cols.map((k, i) => `$${i + 1}${k === 'details' ? '::jsonb' : ''}`);
        await t.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${ph.join(',')})`, vals);
      }
    }
    for (const table of TABLES.filter((x) => x !== 'settings')) {
      await t.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1), (SELECT MAX(id) FROM ${table}) IS NOT NULL)`);
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  if (!file || !process.argv.includes('--confirm')) {
    console.error('Uso: npm run restore -- <arquivo.json> --confirm'); process.exit(1);
  }
  const db = await createDb({ databaseUrl: process.env.DATABASE_URL, dataDir: process.env.PGLITE_DIR || './data/pglite' });
  await restoreDump(db, JSON.parse(fs.readFileSync(file, 'utf8')));
  console.log('Restauração concluída.');
  await db.close();
}
