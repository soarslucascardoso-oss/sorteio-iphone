try { process.loadEnvFile(); } catch { /* sem arquivo .env: usa variáveis do ambiente */ }
import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { runMigrations } from './migrate.js';
import { createApp } from './app.js';

const config = loadConfig();
const db = await createDb({ databaseUrl: config.databaseUrl, dataDir: config.pgliteDir });
await runMigrations(db);
if (!config.adminKeySha256) console.warn('Aviso: ADMIN_API_KEY_SHA256 não definido — a API administrativa está desativada.');
const app = createApp({ db, config });
const server = app.listen(config.port, () => console.log(`Sorteio público (${db.kind}) em http://localhost:${config.port}`));

async function stop() {
  server.close(async () => { await db.close().catch(() => {}); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
