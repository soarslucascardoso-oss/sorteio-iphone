// Teste de integração do painel local contra o back-end público (monorepo: ../../public-app).
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer, ADMIN_KEY } from '../../public-app/test/helpers.js';
import { createAdminApp } from '../server.js';
import { hashPassword } from '../lib/auth.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PASS = 'senha-muito-forte-123';
const PASS_HASH = hashPassword(PASS, { N: 1024 });

async function boot(over = {}) {
  const pub = await startServer();
  const cfg = { port: 0, remoteUrl: pub.base, apiKey: ADMIN_KEY, username: 'admin', passwordHash: PASS_HASH, idleMinutes: 30, maxHours: 8, loginMax: 5, ...over };
  const app = createAdminApp(cfg);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  cfg.port = server.address().port;
  const base = `http://127.0.0.1:${cfg.port}`;
  let cookie = '';
  let csrf = '';
  const call = async (p, { method = 'GET', body, headers = {}, auth = true, raw = false } = {}) => {
    const h = { ...headers };
    if (body !== undefined) h['content-type'] = 'application/json';
    if (auth && cookie) h.cookie = cookie;
    if (auth && csrf && method !== 'GET') h['x-csrf-token'] = csrf;
    const r = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    if (raw) return r;
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* texto */ }
    return { status: r.status, json, text, headers: r.headers };
  };
  const login = async (password = PASS) => {
    const r = await call('/admin/api/login', { method: 'POST', body: { username: 'admin', password }, auth: false });
    if (r.status === 200) { cookie = r.headers.get('set-cookie').split(';')[0]; csrf = r.json.csrfToken; }
    return r;
  };
  const stop = async () => { app.locals.stopTimers(); await new Promise((r) => server.close(r)); await pub.stop(); };
  return { pub, call, login, stop, cfg, base, app };
}

test('painel: APIs exigem sessão; página de login é servida; host estranho é recusado', async () => {
  const t = await boot();
  assert.equal((await t.call('/admin/api/stats', { auth: false })).status, 401);
  assert.equal((await t.call('/admin/api/entries', { auth: false })).status, 401);
  assert.equal((await t.call('/admin/api/export.csv', { auth: false })).status, 401);
  assert.equal((await t.call('/admin/api/draw', { method: 'POST', body: { confirm: 'SORTEAR' }, auth: false })).status, 401);
  const page = await t.call('/admin/');
  assert.equal(page.status, 200); assert.match(page.text, /Painel do sorteio/);
  const evilStatus = await new Promise((res, rej) => {
    const rq = http.request({ host: '127.0.0.1', port: t.cfg.port, path: '/admin/api/session', headers: { host: 'evil.example.com' } }, (r) => { r.resume(); res(r.statusCode); });
    rq.on('error', rej); rq.end();
  });
  assert.equal(evilStatus, 421); // proteção contra DNS rebinding
  const csp = (await t.call('/admin/', { raw: true })).headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/);
  await t.stop();
});

test('login: senha errada, bloqueio por tentativas e sucesso após o prazo de bloqueio', async () => {
  const t = await boot({ loginLockMs: 300 });
  for (let i = 0; i < 5; i++) assert.equal((await t.login('errada-' + i)).status, 401);
  const locked = await t.login(PASS); // mesmo com a senha certa, está bloqueado
  assert.equal(locked.status, 429);
  await new Promise((r) => setTimeout(r, 350));
  assert.equal((await t.login(PASS)).status, 200);
  await t.stop();
});

test('sessão: cookie HttpOnly/SameSite, CSRF obrigatório, logout invalida, expiração por inatividade', async () => {
  const t = await boot();
  const l = await t.login();
  const sc = l.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/);
  assert.equal((await t.call('/admin/api/stats')).status, 200);
  // sem CSRF
  const noCsrf = await fetch(t.base + '/admin/api/registrations/close', { method: 'POST', headers: { cookie: sc.split(';')[0], 'content-type': 'application/json' }, body: '{}' });
  assert.equal(noCsrf.status, 403);
  // origem cruzada
  const cross = await t.call('/admin/api/registrations/close', { method: 'POST', body: {}, headers: { origin: 'https://evil.example' } });
  assert.equal(cross.status, 403);
  const old = sc.split(';')[0];
  assert.equal((await t.call('/admin/api/logout', { method: 'POST', body: {} })).status, 200);
  const after = await fetch(t.base + '/admin/api/stats', { headers: { cookie: old } });
  assert.equal(after.status, 401);
  await t.stop();

  const short = await boot({ idleMinutes: 0.003 }); // ~180 ms
  await short.login();
  assert.equal((await short.call('/admin/api/stats')).status, 200);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await short.call('/admin/api/stats')).status, 401);
  await short.stop();
});

test('fluxo completo pelo painel: participantes, busca, CSV, configurações, encerrar, sortear, duplicidade, publicar', async () => {
  const t = await boot();
  for (let i = 1; i <= 4; i++) assert.equal((await t.pub.enter(`Pessoa Numero${String.fromCharCode(96 + i)}`, `p${i}@exemplo.com`)).status, 201);
  await t.login();
  assert.equal((await t.call('/admin/api/stats')).json.total, 4);
  const list = await t.call('/admin/api/entries?search=p2@&page=1&pageSize=10');
  assert.equal(list.json.total, 1); assert.equal(list.json.items[0].email, 'p2@exemplo.com');
  const csv = await t.call('/admin/api/export.csv');
  assert.equal(csv.status, 200); assert.match(csv.headers.get('content-disposition'), /attachment/); assert.equal(csv.text.trim().split('\r\n').length, 5);
  const set = await t.call('/admin/api/settings', { method: 'PUT', body: { title: 'Meu sorteio', result_at: '2030-05-01T15:00:00Z' } });
  assert.equal(set.status, 200);
  assert.equal((await t.pub.api('/api/public/config')).json.title, 'Meu sorteio');
  assert.equal((await t.call('/admin/api/draw', { method: 'POST', body: { confirm: 'SORTEAR' } })).status, 409); // ainda aberto
  assert.equal((await t.call('/admin/api/registrations/close', { method: 'POST', body: {} })).status, 200);
  assert.equal((await t.pub.enter('Nova Pessoa', 'n@exemplo.com')).status, 403);
  const d = await t.call('/admin/api/draw', { method: 'POST', body: { confirm: 'SORTEAR' } });
  assert.equal(d.status, 201); assert.ok(d.json.winner.name);
  assert.equal((await t.call('/admin/api/draw', { method: 'POST', body: { confirm: 'SORTEAR' } })).status, 409); // duplicado
  assert.equal((await t.call('/admin/api/result/publish', { method: 'POST', body: { published: true } })).status, 200);
  assert.equal((await t.pub.api('/api/public/result')).json.published, true);
  const audit = (await t.call('/admin/api/audit')).json;
  assert.equal(audit.items[0].actor, 'admin');
  assert.ok(audit.items.some((x) => x.action === 'draw'));
  await t.stop();
});

test('chave administrativa errada: painel mostra erro de conexão, não vaza dados', async () => {
  const t = await boot({ apiKey: 'a'.repeat(43) });
  await t.login();
  const r = await t.call('/admin/api/stats');
  assert.equal(r.status, 502); assert.equal(r.json.code, 'REMOTE_AUTH_FAILED');
  await t.stop();
});

test('painel fora do ar do lado remoto retorna 502 amigável', async () => {
  const t = await boot({ remoteUrl: 'http://127.0.0.1:9' });
  await t.login();
  const r = await t.call('/admin/api/stats');
  assert.equal(r.status, 502); assert.equal(r.json.code, 'REMOTE_UNAVAILABLE');
  await t.stop();
});

test('REMOTE_URL sem HTTPS (fora de localhost) é recusada', async () => {
  assert.throws(() => createAdminApp({ port: 3000, remoteUrl: 'http://meusorteio.com.br', apiKey: 'x'.repeat(43), username: 'a', passwordHash: 'x', idleMinutes: 1, maxHours: 1 }).locals.stopTimers());
});

test('o processo do painel escuta só em 127.0.0.1 (recusa conexões pela rede)', async () => {
  const ext = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
  const port = 3900 + Math.floor(Math.random() * 90);
  const env = { ...process.env, REMOTE_URL: 'https://exemplo.invalid', ADMIN_API_KEY: 'k'.repeat(43), ADMIN_USERNAME: 'admin', ADMIN_PASSWORD_HASH: PASS_HASH, ADMIN_PORT: String(port) };
  const child = spawn(process.execPath, [path.join(here, '..', 'server.js')], { env, cwd: path.join(here, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { child.stdout.on('data', (d) => /Painel local/.test(String(d)) && resolve()); child.on('exit', () => reject(new Error('painel não iniciou'))); setTimeout(() => reject(new Error('timeout')), 8000); });
  const canConnect = (host) => new Promise((res) => { const s = net.connect({ host, port, timeout: 1500 }, () => { s.destroy(); res(true); }); s.on('error', () => res(false)); s.on('timeout', () => { s.destroy(); res(false); }); });
  assert.equal(await canConnect('127.0.0.1'), true);
  if (ext) assert.equal(await canConnect(ext.address), false, `não deveria aceitar conexão em ${ext.address}`);
  else console.log('(sem interface de rede externa neste ambiente: checagem de rede ignorada)');
  child.kill();
});
