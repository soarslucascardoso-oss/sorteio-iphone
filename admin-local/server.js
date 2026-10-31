// Painel administrativo LOCAL. Escuta somente em 127.0.0.1 — nunca publique este diretório.
import express from 'express';
import helmet from 'helmet';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SessionStore, LoginLimiter, verifyPassword, parseCookies } from './lib/auth.js';
import { createRemote } from './lib/remote.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const COOKIE = 'admin_sid';

export function createAdminApp(cfg) {
  const remote = createRemote({ baseUrl: cfg.remoteUrl, apiKey: cfg.apiKey });
  const sessions = new SessionStore({ idleMs: cfg.idleMinutes * 60_000, maxMs: cfg.maxHours * 3_600_000 });
  const limiter = new LoginLimiter({ max: cfg.loginMax ?? 5, lockMs: cfg.loginLockMs ?? 15 * 60_000 });
  const sweep = setInterval(() => sessions.sweep(), 60_000); sweep.unref();
  const app = express();
  app.disable('x-powered-by');
  app.locals.sessions = sessions; app.locals.limiter = limiter; app.locals.stopTimers = () => clearInterval(sweep);

  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], frameAncestors: ["'none'"], formAction: ["'self'"], objectSrc: ["'none'"], baseUri: ["'self'"], upgradeInsecureRequests: null } }, strictTransportSecurity: false }));
  app.use((req, res, next) => { // proteção contra DNS rebinding: só aceita Host local
    const allowed = new Set([`localhost:${cfg.port}`, `127.0.0.1:${cfg.port}`, `[::1]:${cfg.port}`, ...(cfg.extraHosts || [])]);
    if (!allowed.has(String(req.headers.host || '').toLowerCase())) return res.status(421).type('text/plain').send('Host não permitido.');
    next();
  });
  app.get('/', (_req, res) => res.redirect('/admin'));
  app.use('/admin', express.static(path.join(here, 'public'), { index: 'index.html', dotfiles: 'ignore', setHeaders: (r) => r.set('Cache-Control', 'no-store') }));

  const api = express.Router();
  api.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  api.use(express.json({ limit: '64kb' }));
  const fail = (res, status, code, message) => res.status(status).json({ ok: false, code, message });

  const sidOf = (req) => parseCookies(req.headers.cookie)[COOKIE];
  const cookieOpts = (maxAgeMs) => `Path=/; HttpOnly; SameSite=Strict${maxAgeMs === 0 ? '; Max-Age=0' : ''}`;

  api.post('/login', async (req, res) => {
    const origin = req.get('origin');
    if (origin && new URL(origin).host !== req.headers.host) return fail(res, 403, 'BAD_ORIGIN', 'Origem inválida.');
    const wait = limiter.retryAfterMs();
    if (wait > 0) { res.set('Retry-After', String(Math.ceil(wait / 1000))); return fail(res, 429, 'LOCKED', `Muitas tentativas. Tente novamente em ${Math.ceil(wait / 60000)} min.`); }
    const { username, password } = req.body || {};
    const userOk = typeof username === 'string' && username === cfg.username;
    const passOk = typeof password === 'string' && password.length <= 256 && verifyPassword(password, cfg.passwordHash); // sempre calcula o hash
    if (!(userOk && passOk)) { limiter.fail(); return fail(res, 401, 'BAD_CREDENTIALS', 'Usuário ou senha incorretos.'); }
    limiter.success();
    const s = sessions.create(cfg.username);
    res.set('Set-Cookie', `${COOKIE}=${s.id}; ${cookieOpts()}`);
    res.json({ ok: true, user: cfg.username, csrfToken: s.csrf });
  });

  api.get('/session', (req, res) => {
    const s = sessions.get(sidOf(req));
    res.json(s ? { ok: true, authenticated: true, user: s.user, csrfToken: s.csrf } : { ok: true, authenticated: false });
  });

  // Tudo abaixo exige sessão válida; métodos que alteram dados exigem também o token CSRF.
  api.use((req, res, next) => {
    const s = sessions.get(sidOf(req));
    if (!s) return fail(res, 401, 'UNAUTHENTICATED', 'Sessão expirada. Faça login novamente.');
    if (req.method !== 'GET') {
      const origin = req.get('origin');
      if (origin && new URL(origin).host !== req.headers.host) return fail(res, 403, 'BAD_ORIGIN', 'Origem inválida.');
      if (req.get('x-csrf-token') !== s.csrf) return fail(res, 403, 'BAD_CSRF', 'Token de segurança inválido. Recarregue a página.');
    }
    req.session = s; req.sid = sidOf(req);
    next();
  });

  api.post('/logout', (req, res) => { sessions.destroy(req.sid); res.set('Set-Cookie', `${COOKIE}=; ${cookieOpts(0)}`); res.json({ ok: true }); });

  const pick = (q, keys) => Object.fromEntries(keys.filter((k) => q[k] !== undefined).map((k) => [k, q[k]]));
  const send = (res, r) => res.status(r.status).json(r.json);
  const FILTERS = ['search', 'from', 'to', 'page', 'pageSize'];
  api.get('/stats', async (req, res) => send(res, await remote('GET', '/stats', { actor: req.session.user })));
  api.get('/entries', async (req, res) => send(res, await remote('GET', '/entries', { query: pick(req.query, FILTERS), actor: req.session.user })));
  api.get('/export.csv', async (req, res) => {
    const r = await remote('GET', '/entries/export.csv', { query: pick(req.query, ['search', 'from', 'to']), actor: req.session.user, raw: true });
    if (r.json) return send(res, r);
    res.set('Content-Disposition', `attachment; filename="participantes-${new Date().toISOString().slice(0, 10)}.csv"`).type('text/csv; charset=utf-8').send(r.text);
  });
  api.get('/settings', async (req, res) => send(res, await remote('GET', '/settings', { actor: req.session.user })));
  api.put('/settings', async (req, res) => send(res, await remote('PUT', '/settings', { body: req.body, actor: req.session.user })));
  api.post('/registrations/close', async (req, res) => send(res, await remote('POST', '/registrations/close', { body: {}, actor: req.session.user })));
  api.post('/registrations/open', async (req, res) => send(res, await remote('POST', '/registrations/open', { body: {}, actor: req.session.user })));
  api.post('/draw', async (req, res) => send(res, await remote('POST', '/draw', { body: { confirm: req.body?.confirm, reason: req.body?.reason }, actor: req.session.user })));
  api.get('/draws', async (req, res) => send(res, await remote('GET', '/draws', { actor: req.session.user })));
  api.post('/result/publish', async (req, res) => send(res, await remote('POST', '/result/publish', { body: { published: req.body?.published === true }, actor: req.session.user })));
  api.get('/audit', async (req, res) => send(res, await remote('GET', '/audit', { query: pick(req.query, ['page']), actor: req.session.user })));
  api.use((_req, res) => fail(res, 404, 'NOT_FOUND', 'Não encontrado.'));

  app.use('/admin/api', api);
  app.use((_req, res) => res.status(404).type('text/plain').send('Não encontrado'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => { console.error('erro:', err.message); fail(res, err.status || 500, 'INTERNAL', 'Erro interno.'); });
  return app;
}

export function loadAdminConfig(env = process.env) {
  const need = ['REMOTE_URL', 'ADMIN_API_KEY', 'ADMIN_USERNAME', 'ADMIN_PASSWORD_HASH'];
  const missing = need.filter((k) => !env[k]);
  if (missing.length) throw new Error(`Variáveis ausentes: ${missing.join(', ')}. Rode "npm run setup".`);
  if (env.ADMIN_API_KEY.length < 32) throw new Error('ADMIN_API_KEY muito curta.');
  return {
    port: Number(env.ADMIN_PORT || 3000), remoteUrl: env.REMOTE_URL, apiKey: env.ADMIN_API_KEY,
    username: env.ADMIN_USERNAME, passwordHash: env.ADMIN_PASSWORD_HASH,
    idleMinutes: Number(env.SESSION_IDLE_MINUTES || 30), maxHours: Number(env.SESSION_MAX_HOURS || 8),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.loadEnvFile(path.join(here, '.env')); } catch { /* sem .env */ }
  let cfg;
  try { cfg = loadAdminConfig(); } catch (e) { console.error(e.message); process.exit(1); }
  const app = createAdminApp(cfg);
  // Loopback fixo: o painel não aceita conexões de outras máquinas.
  app.listen(cfg.port, '127.0.0.1', () => console.log(`Painel local: http://localhost:${cfg.port}/admin  (somente neste computador)`));
}
