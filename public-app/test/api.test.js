import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './helpers.js';
import { createDb } from '../server/db.js';
import { SUCCESS_MESSAGE } from '../server/app.js';

test('inscrição pública sem login: sucesso, número, mensagem e data/hora', async () => {
  const s = await startServer();
  const r = await s.enter('Maria da Silva', 'Maria@Exemplo.com');
  assert.equal(r.status, 201);
  assert.equal(r.json.message, SUCCESS_MESSAGE);
  assert.match(r.json.entryNumber, /^\d{6}$/);
  const { rows } = await s.db.query('SELECT name, email, created_at FROM entries');
  assert.equal(rows[0].email, 'maria@exemplo.com');
  assert.ok(rows[0].created_at instanceof Date);
  await s.stop();
});

test('validação no back-end: nome, e-mail e consentimento', async () => {
  const s = await startServer();
  const bad = [
    ['Maria', 'a@b.com'], ['', 'a@b.com'], ['Maria Silva', 'sem-arroba'], ['Maria Silva', 'a@b'], ['Maria <b>Silva</b>', 'a@b.com'],
    ['Maria Silva', 'a..b@exemplo.com'], ['Maria Silva', 'x'.repeat(70) + '@exemplo.com'],
  ];
  for (const [n, e] of bad) {
    const r = await s.enter(n, e);
    assert.equal(r.status, 422, `${n} / ${e}`);
    assert.ok(r.json.errors);
  }
  const noConsent = await s.api('/api/entries', { method: 'POST', body: { name: 'Maria Silva', email: 'm@exemplo.com', consent: false, formToken: await s.token() } });
  assert.equal(noConsent.status, 422);
  assert.ok(noConsent.json.errors.consent);
  const arr = await s.api('/api/entries', { method: 'POST', body: [1, 2] });
  assert.ok([400, 422].includes(arr.status));
  assert.equal((await s.db.query('SELECT COUNT(*)::int n FROM entries')).rows[0].n, 0);
  await s.stop();
});

test('SQL injection não afeta o banco (consulta parametrizada)', async () => {
  const s = await startServer();
  const r = await s.enter("Robert'); DROP TABLE entries;-- Silva", 'bob@exemplo.com');
  assert.equal(r.status, 422); // caracteres inválidos no nome
  const r2 = await s.enter('Robert Silva', "x'); DROP TABLE entries;--@exemplo.com");
  assert.equal(r2.status, 422);
  assert.equal((await s.db.query('SELECT COUNT(*)::int n FROM entries')).rows[0].n, 0);
  await s.stop();
});

test('e-mail duplicado é bloqueado (restrição única, inclusive concorrente)', async () => {
  const s = await startServer();
  assert.equal((await s.enter('Ana Souza', 'ana@exemplo.com')).status, 201);
  const d = await s.enter('Outra Pessoa', 'ANA@exemplo.com ');
  assert.equal(d.status, 409);
  assert.equal(d.json.code, 'EMAIL_DUPLICATE');
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => s.enter(`Pessoa Numero${'ab'[i % 2]}`, 'race@exemplo.com')));
  assert.equal(results.filter((x) => x.status === 201).length, 1);
  assert.equal((await s.db.query('SELECT COUNT(*)::int n FROM entries')).rows[0].n, 2);
  await s.stop();
});

test('honeypot, token do formulário e origem', async () => {
  const s = await startServer({ env: { MIN_FORM_SECONDS: '30' } });
  const early = await s.enter('Ana Souza', 'ana@exemplo.com');
  assert.equal(early.status, 400); // rápido demais
  assert.equal(early.json.code, 'FORM_EXPIRED');
  const forged = await s.api('/api/entries', { method: 'POST', body: { name: 'Ana Souza', email: 'ana@exemplo.com', consent: true, formToken: '1700000000000.fake' } });
  assert.equal(forged.status, 400);
  await s.stop();

  const s2 = await startServer();
  const hp = await s2.enter('Robô Silva', 'bot@exemplo.com', { website: 'http://spam' });
  assert.equal(hp.status, 201);
  assert.equal((await s2.db.query('SELECT COUNT(*)::int n FROM entries')).rows[0].n, 0); // não grava
  const evil = await s2.api('/api/entries', { method: 'POST', headers: { origin: 'https://evil.example' }, body: { name: 'Ana Souza', email: 'ana@exemplo.com', consent: true, formToken: await s2.token() } });
  assert.equal(evil.status, 403);
  const form = await fetch(s2.base + '/api/entries', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(form.status, 415);
  await s2.stop();
});

test('limitação de requisições na inscrição', async () => {
  const s = await startServer({ env: { ENTRIES_RATE_LIMIT: '3' } });
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await s.enter('Ana Souza', `a${i}@exemplo.com`)).status);
  assert.deepEqual(codes.slice(3), [429, 429]);
  await s.stop();
});


test('rate limit de inscrições persiste após reiniciar o processo e usa banco compartilhado', async () => {
  const s = await startServer({ env: { ENTRIES_RATE_LIMIT: '2' } });
  assert.equal((await s.enter('Ana Souza', 'a1@exemplo.com')).status, 201);
  await s.stop({ keepDb: true });

  const s2 = await startServer({ db: s.db, env: { ENTRIES_RATE_LIMIT: '2' } });
  assert.equal((await s2.enter('Bruna Souza', 'b1@exemplo.com')).status, 201);
  const blocked = await s2.enter('Carla Souza', 'c1@exemplo.com');
  assert.equal(blocked.status, 429);
  // A tabela armazena somente o HMAC da chave do cliente, nunca o IP em texto puro.
  const { rows } = await s2.db.query('SELECT bucket_key FROM rate_limits');
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((x) => /^[0-9a-f]{64}$/.test(x.bucket_key.trim())));
  await s2.stop();
});

test('inscrição aguarda o lock de encerramento e não grava depois de fechar', async () => {
  const s = await startServer();
  let request;
  await s.db.tx(async (t) => {
    await t.query('SELECT id FROM settings WHERE id = 1 FOR UPDATE');
    request = s.enter('Ana Souza', 'ana@exemplo.com');
    await new Promise((resolve) => setTimeout(resolve, 40));
    await t.query('UPDATE settings SET registrations_closed = true WHERE id = 1');
  });
  const result = await request;
  assert.equal(result.status, 403);
  assert.equal(result.json.code, 'REGISTRATIONS_CLOSED');
  assert.equal((await s.db.query('SELECT COUNT(*)::int n FROM entries')).rows[0].n, 0);
  await s.stop();
});

test('persistência após reinicialização do servidor e do banco', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sorteio-'));
  const s = await startServer({ dataDir: dir });
  assert.equal((await s.enter('Ana Souza', 'ana@exemplo.com')).status, 201);
  await s.stop();
  const s2 = await startServer({ dataDir: dir });
  const { rows } = await s2.db.query('SELECT email FROM entries');
  assert.deepEqual(rows.map((r) => r.email), ['ana@exemplo.com']);
  assert.equal((await s2.enter('Ana Souza', 'ana@exemplo.com')).status, 409);
  await s2.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('API pública não expõe participantes; /admin e APIs admin bloqueados sem chave', async () => {
  const s = await startServer();
  await s.enter('Ana Souza', 'ana@exemplo.com');
  const cfg = await s.api('/api/public/config');
  assert.ok(!JSON.stringify(cfg.json).includes('ana@exemplo.com'));
  assert.equal((await s.api('/admin')).status, 404);
  assert.equal((await s.api('/admin/index.html')).status, 404);
  for (const p of ['/internal/admin/stats', '/internal/admin/entries', '/internal/admin/entries/export.csv', '/internal/admin/settings', '/internal/admin/audit', '/internal/admin/draws']) {
    assert.equal((await s.api(p)).status, 401, p);
    assert.equal((await s.api(p, { headers: { authorization: 'Bearer ' + 'a'.repeat(43) } })).status, 401, p + ' chave errada');
  }
  for (const p of ['/internal/admin/draw', '/internal/admin/registrations/close', '/internal/admin/result/publish']) {
    assert.equal((await s.api(p, { method: 'POST', body: {} })).status, 401, p);
  }
  assert.equal((await s.api('/internal/admin/stats', { admin: true })).status, 200);
  await s.stop();

  const off = await startServer({ env: { ADMIN_API_KEY_SHA256: '' } });
  assert.equal((await off.api('/internal/admin/stats', { admin: true })).status, 404);
  await off.stop();
});

test('cabeçalhos de segurança e health check', async () => {
  const s = await startServer();
  const r = await s.api('/', { raw: true });
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-powered-by'), null);
  assert.equal((await s.api('/healthz')).status, 200);
  await s.stop();
});
