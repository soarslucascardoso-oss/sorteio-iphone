// Backup lógico (JSON) de todas as tabelas. Uso: DATABASE_URL=... npm run backup
try { process.loadEnvFile(); } catch { /* sem .env */ }
import fs from 'node:fs';
import path from 'node:path';
import { createDb } from '../server/db.js';

export const TABLES = ['settings', 'entries', 'draws', 'audit_log'];

export async function dumpAll(db) {
  const tables = {};
  for (const t of TABLES) tables[t] = (await db.query(`SELECT * FROM ${t} ORDER BY id`)).rows;
  return { format: 'sorteio-backup', version: 1, createdAt: new Date().toISOString(), tables };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = await createDb({ databaseUrl: process.env.DATABASE_URL, dataDir: process.env.PGLITE_DIR || './data/pglite' });
  const dump = await dumpAll(db);
  const dir = process.env.BACKUP_DIR || './backups';
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `backup-${dump.createdAt.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(dump), { mode: 0o600 });
  console.log(`Backup salvo em ${file} (${dump.tables.entries.length} inscrições). Contém dados pessoais: guarde com segurança.`);
  await db.close();
}
