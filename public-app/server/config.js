import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export function loadConfig(env = process.env) {
  const isProd = env.NODE_ENV === 'production';
  const formSecret = env.FORM_SECRET || (isProd ? '' : crypto.randomBytes(32).toString('hex'));
  if (isProd) {
    if (!env.DATABASE_URL) throw new Error('DATABASE_URL é obrigatório em produção.');
    if (formSecret.length < 32) throw new Error('FORM_SECRET (mín. 32 caracteres) é obrigatório em produção.');
  }
  const turnstileSiteKey = (env.TURNSTILE_SITE_KEY || '').trim();
  const turnstileSecret = (env.TURNSTILE_SECRET || '').trim();
  if (Boolean(turnstileSiteKey) !== Boolean(turnstileSecret)) {
    throw new Error('TURNSTILE_SITE_KEY e TURNSTILE_SECRET devem ser configuradas juntas.');
  }
  const minFormSeconds = env.MIN_FORM_SECONDS === undefined ? 3 : Number(env.MIN_FORM_SECONDS);
  const entriesPerWindow = env.ENTRIES_RATE_LIMIT === undefined ? 10 : Number(env.ENTRIES_RATE_LIMIT);
  if (!Number.isFinite(minFormSeconds) || minFormSeconds < 0 || minFormSeconds > 300) throw new Error('MIN_FORM_SECONDS deve estar entre 0 e 300.');
  if (!Number.isInteger(entriesPerWindow) || entriesPerWindow < 1 || entriesPerWindow > 1000) throw new Error('ENTRIES_RATE_LIMIT deve ser um inteiro entre 1 e 1000.');
  const adminHash = (env.ADMIN_API_KEY_SHA256 || '').trim().toLowerCase();
  if (adminHash && !/^[0-9a-f]{64}$/.test(adminHash)) throw new Error('ADMIN_API_KEY_SHA256 deve ser um SHA-256 em hex (64 caracteres).');
  const tp = env.TRUST_PROXY;
  return {
    isProd,
    port: Number(env.PORT || 8080),
    databaseUrl: env.DATABASE_URL || '',
    pgliteDir: env.PGLITE_DIR || path.join(here, '..', 'data', 'pglite'),
    trustProxy: tp === undefined || tp === '' ? false : /^\d+$/.test(tp) ? Number(tp) : tp === 'true' ? true : tp,
    formSecret,
    minFormSeconds,
    adminKeySha256: adminHash,
    turnstileSiteKey,
    turnstileSecret,
    allowedOrigins: (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    publicDir: path.join(here, '..', 'public'),
    entriesPerWindow,
  };
}
