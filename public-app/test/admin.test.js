import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';
import { createDb } from '../server/db.js';
import { dumpAll } from '../scripts/backup.js';
import { restoreDump } from '../scripts/restore.js';

async function seed(s, n) {
  for (let i = 1; i <= n; i++) assert.equal((await s.enter(`Pessoa Numero${String.fromCharCode(96 + i)}`, `p${i}@exemplo.com`)).status, 201);
}

test('painel: total, listagem, busca, paginação, filtro por período', async () => {
  const s = await startServer();
  await seed(s, 5);
  await s.enter('João Ótimo', 'joao@exemplo.com');
  const st = (await s.api('/internal/admin/stats', { admin: true })).json;
  assert.equal(st.total, 6);
  const list = (await s.api('/internal/admin/entries?pageSize=2&page=2', { admin: true })).json;
  assert.equal(list.items.length, 2); assert.equal(list.total, 6); assert.equal(list.page, 2);
  assert.equal((await s.api('/internal/admin/entries?search=jo%C3%A3o', { admin: true })).json.total, 1);
  assert.equal((await s.api('/internal/admin/entries?search=p3@', { admin: true })).json.total, 1);
  assert.equal((await s.api('/internal/admin/entries?search=%25', { admin: true })).json.total, 0); // % tratado literalmente
  const future = new Date(Date.now() + 86400000).toISOString();
  assert.equal((await s.api(`/internal/admin/entries?from=${encodeURIComponent(future)}`, { admin: true })).json.total, 0);
  assert.equal((await s.api('/internal/admin/entries?from=bobagem', { admin: true })).status, 400);
  await s.stop();
});

test('exportação CSV (com proteção contra injeção de fórmula) e auditoria', async () => {
  const s = await startServer();
  await s.db.query("INSERT INTO entries (name, email, email_normalized) VALUES ('=HYPERLINK(x) Silva', 'f@exemplo.com', 'f@exemplo.com')");
  await seed(s, 2);
  const r = await s.api('/internal/admin/entries/export.csv', { admin: true });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  const lines = r.text.replace('\uFEFF', '').trim().split('\r\n');
  assert.equal(lines[0], 'numero,nome,email,inscrito_em');
  assert.equal(lines.length, 4);
  assert.ok(lines[1].includes("'=HYPERLINK"));
  const audit = (await s.api('/internal/admin/audit', { admin: true })).json;
  assert.equal(audit.items[0].action, 'export_csv');
  assert.equal(audit.items[0].actor, 'tester');
  await s.stop();
});

test('configurações: edição validada, auditada e refletida no site público', async () => {
  const s = await startServer();
  const put = await s.api('/internal/admin/settings', { method: 'PUT', admin: true, body: { title: 'Novo título', description: 'Nova descrição', end_at: '2030-01-10T12:00:00Z', result_at: '2030-01-15T12:00:00Z', contact_email: 'contato@exemplo.com' } });
  assert.equal(put.status, 200);
  assert.deepEqual(put.json.changed.sort(), ['contact_email', 'description', 'end_at', 'result_at', 'title']);
  const pub = (await s.api('/api/public/config')).json;
  assert.equal(pub.title, 'Novo título'); assert.equal(pub.endAt, '2030-01-10T12:00:00.000Z'); assert.equal(pub.state, 'open');
  assert.equal((await s.api('/internal/admin/settings', { method: 'PUT', admin: true, body: { title: 'x' } })).status, 422);
  assert.equal((await s.api('/internal/admin/settings', { method: 'PUT', admin: true, body: { start_at: '2030-02-01T00:00:00Z', end_at: '2030-01-01T00:00:00Z' } })).status, 422);
  assert.equal((await s.api('/internal/admin/settings', { method: 'PUT', admin: true, body: { contact_email: 'ruim' } })).status, 422);
  await s.stop();
});

test('encerrar inscrições bloqueia novas e inscrições fora da data também', async () => {
  const s = await startServer();
  await seed(s, 1);
  assert.equal((await s.api('/internal/admin/registrations/close', { method: 'POST', admin: true, body: {} })).status, 200);
  const closed = await s.enter('Nova Pessoa', 'nova@exemplo.com');
  assert.equal(closed.status, 403); assert.equal(closed.json.code, 'REGISTRATIONS_CLOSED');
  assert.equal((await s.api('/api/public/config')).json.state, 'closed');
  await s.api('/internal/admin/registrations/open', { method: 'POST', admin: true, body: {} });
  assert.equal((await s.enter('Nova Pessoa', 'nova@exemplo.com')).status, 201);
  await s.api('/internal/admin/settings', { method: 'PUT', admin: true, body: { end_at: '2020-01-01T00:00:00Z' } });
  assert.equal((await s.enter('Outra Pessoa', 'outra@exemplo.com')).json.code, 'REGISTRATIONS_ENDED');
  await s.stop();
});

test('sorteio: exige encerramento, confirmação, evita duplicidade, exige justificativa e audita', async () => {
  const s = await startServer();
  await seed(s, 5);
  const D = (body) => s.api('/internal/admin/draw', { method: 'POST', admin: true, body });
  assert.equal((await D({ confirm: 'SORTEAR' })).json.code, 'REGISTRATIONS_OPEN');
  await s.api('/internal/admin/registrations/close', { method: 'POST', admin: true, body: {} });
  assert.equal((await D({})).json.code, 'CONFIRM_REQUIRED');
  assert.equal((await D({ confirm: 'sim' })).status, 400);

  const first = await D({ confirm: 'SORTEAR' });
  assert.equal(first.status, 201);
  assert.equal(first.json.eligibleCount, 5);
  const winnerId = first.json.winner.entryId;
  const { rows } = await s.db.query('SELECT * FROM draws WHERE annulled_at IS NULL');
  assert.equal(rows.length, 1); assert.equal(rows[0].entry_id, winnerId);

  // cliques duplos / execuções simultâneas: nenhum cria um segundo sorteio ativo
  const dup = await Promise.all([D({ confirm: 'SORTEAR' }), D({ confirm: 'SORTEAR' }), D({ confirm: 'SORTEAR', reason: 'curto' })]);
  assert.ok(dup.every((r) => r.status === 409 && r.json.code === 'ALREADY_DRAWN'));
  assert.equal((await s.db.query('SELECT COUNT(*)::int n FROM draws')).rows[0].n, 1);

  const redo = await D({ confirm: 'SORTEAR', reason: 'Ganhador não respondeu no prazo' });
  assert.equal(redo.status, 201); assert.equal(redo.json.redraw, true);
  assert.notEqual(redo.json.winner.entryId, winnerId); // vencedor anulado não concorre de novo
  assert.equal(redo.json.eligibleCount, 4);
  const draws = (await s.api('/internal/admin/draws', { admin: true })).json.items;
  assert.equal(draws.length, 2); assert.ok(draws[1].annulledAt); assert.equal(draws[1].annulledReason, 'Ganhador não respondeu no prazo');
  const actions = (await s.api('/internal/admin/audit', { admin: true })).json.items.map((x) => x.action);
  assert.ok(actions.includes('draw') && actions.includes('draw_redo'));
  await s.stop();
});

test('sorteio respeita o período e alcança todos os elegíveis', async () => {
  const s = await startServer();
  await s.db.query("INSERT INTO entries (name, email, email_normalized, created_at) VALUES ('Antes Do Periodo', 'a@e.com', 'a@e.com', '2020-01-01T00:00:00Z'), ('Dentro Do Periodo', 'b@e.com', 'b@e.com', '2030-01-05T00:00:00Z'), ('Depois Do Periodo', 'c@e.com', 'c@e.com', '2031-01-01T00:00:00Z')");
  await s.api('/internal/admin/settings', { method: 'PUT', admin: true, body: { start_at: '2030-01-01T00:00:00Z', end_at: '2030-02-01T00:00:00Z' } });
  await s.api('/internal/admin/registrations/close', { method: 'POST', admin: true, body: {} });
  const r = await s.api('/internal/admin/draw', { method: 'POST', admin: true, body: { confirm: 'SORTEAR' } });
  assert.equal(r.json.eligibleCount, 1); assert.equal(r.json.winner.name, 'Dentro Do Periodo');
  await s.stop();

  const u = await startServer();
  for (let i = 0; i < 4; i++) await u.db.query('INSERT INTO entries (name, email, email_normalized) VALUES ($1,$2,$2)', [`Pessoa Numero${i}`, `u${i}@e.com`]);
  await u.api('/internal/admin/registrations/close', { method: 'POST', admin: true, body: {} });
  const counts = {};
  for (let i = 0; i < 120; i++) {
    const d = await u.api('/internal/admin/draw', { method: 'POST', admin: true, body: { confirm: 'SORTEAR', reason: i ? 'repetição de teste estatístico' : undefined } });
    if (d.status !== 201) { await u.db.query('DELETE FROM draws'); await u.db.query('UPDATE draws SET annulled_at = now()'); continue; }
    counts[d.json.winner.entryId] = (counts[d.json.winner.entryId] || 0) + 1;
    await u.db.query('DELETE FROM draws');
  }
  assert.equal(Object.keys(counts).length, 4); // todos os 4 foram sorteados ao menos uma vez
  await u.stop();
});

test('resultado público só aparece após publicação e mascara os dados', async () => {
  const s = await startServer();
  await seed(s, 3);
  assert.equal((await s.api('/api/public/result')).json.published, false);
  assert.equal((await s.api('/internal/admin/result/publish', { method: 'POST', admin: true, body: { published: true } })).status, 409); // sem sorteio
  await s.api('/internal/admin/registrations/close', { method: 'POST', admin: true, body: {} });
  const d = await s.api('/internal/admin/draw', { method: 'POST', admin: true, body: { confirm: 'SORTEAR' } });
  assert.equal((await s.api('/api/public/result')).json.published, false); // sorteou, mas não publicou
  await s.api('/internal/admin/result/publish', { method: 'POST', admin: true, body: { published: true } });
  const res = await s.api('/api/public/result');
  assert.equal(res.json.published, true);
  assert.match(res.json.winner.maskedName, /^[^ ]\*\*\* [^ ]\*\*\*$/);
  assert.ok(!res.text.includes('@') && !res.text.includes(d.json.winner.name));
  await s.stop();
});

test('backup e restauração em banco novo preservam inscrições, sorteio e auditoria', async () => {
  const s = await startServer();
  await seed(s, 3);
  await s.api('/internal/admin/registrations/close', { method: 'POST', admin: true, body: {} });
  const d = await s.api('/internal/admin/draw', { method: 'POST', admin: true, body: { confirm: 'SORTEAR' } });
  const dump = JSON.parse(JSON.stringify(await dumpAll(s.db)));
  const fresh = await createDb({});
  await restoreDump(fresh, dump);
  const n = (await fresh.query('SELECT COUNT(*)::int n FROM entries')).rows[0].n;
  const w = (await fresh.query('SELECT entry_id FROM draws WHERE annulled_at IS NULL')).rows[0].entry_id;
  assert.equal(n, 3); assert.equal(w, d.json.winner.entryId);
  assert.equal((await fresh.query('SELECT registrations_closed FROM settings')).rows[0].registrations_closed, true);
  await fresh.query("INSERT INTO entries (name, email, email_normalized) VALUES ('Nova Pessoa','novo@e.com','novo@e.com')"); // sequência ajustada
  await assert.rejects(() => restoreDump(fresh, dump)); // recusa banco não vazio
  await fresh.close(); await s.stop();
});
