import crypto from 'node:crypto';
import { loadConfig } from '../server/config.js';
import { createDb } from '../server/db.js';
import { runMigrations } from '../server/migrate.js';
import { createApp } from '../server/app.js';

export const ADMIN_KEY = crypto.randomBytes(32).toString('base64url');
export const ADMIN_HASH = crypto.createHash('sha256').update(ADMIN_KEY).digest('hex');

const seen = new Set();
async function openDb(dataDir) {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return createDb({ dataDir });
  const db = await createDb({ databaseUrl: url });
  const key = dataDir || Symbol();
  if (!seen.has(key)) { // banco limpo a cada teste (exceto reabertura do mesmo "dataDir", usada no teste de persistência)
    await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    if (dataDir) seen.add(key);
  }
  return db;
}

export async function startServer({ dataDir, db: existing, env = {} } = {}) {
  const config = loadConfig({ NODE_ENV: 'test', MIN_FORM_SECONDS: '0', ADMIN_API_KEY_SHA256: ADMIN_HASH, FORM_SECRET: 'x'.repeat(40), ENTRIES_RATE_LIMIT: '1000', ...env });
  const db = existing || await openDb(dataDir);
  await runMigrations(db, () => {});
  const app = createApp({ db, config });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (path, { method = 'GET', body, headers = {}, admin = false, raw = false } = {}) => {
    const h = { ...headers };
    if (body !== undefined) h['content-type'] = 'application/json';
    if (admin) { h.authorization = `Bearer ${ADMIN_KEY}`; h['x-admin-actor'] = 'tester'; }
    const r = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    if (raw) return r;
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = null; }
    return { status: r.status, json, text, headers: r.headers };
  };
  const token = async () => (await api('/api/public/config')).json.formToken;
  const enter = async (name, email, extra = {}) => api('/api/entries', { method: 'POST', body: { name, email, consent: true, formToken: await token(), ...extra } });
  const stop = async ({ keepDb = false } = {}) => { await new Promise((r) => server.close(r)); if (!keepDb) await db.close(); };
  return { base, api, enter, token, db, stop, config };
}
