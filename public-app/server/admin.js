// API administrativa (server-to-server). Só responde com a chave secreta do painel local.
import crypto from 'node:crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { HttpError, isValidEmail, pad } from './validation.js';
import { addAudit, performDraw } from './draw.js';
import { DbRateLimitStore } from './rate-limit-store.js';

const esc = (s) => String(s).replace(/[\\%_]/g, (c) => '\\' + c);
const SETTINGS_PUBLIC_FIELDS = ['title', 'description', 'prize_name', 'start_at', 'end_at', 'result_at', 'registrations_closed', 'result_published', 'rules_text', 'organizer_name', 'contact_email', 'authorization_number', 'updated_at'];

function csvCell(v) {
  let s = v instanceof Date ? v.toISOString() : String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // evita injeção de fórmulas em planilhas
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function parseDate(v, field) {
  if (v === undefined || v === null || v === '') return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, 'BAD_DATE', `Data inválida em ${field}.`);
  return d;
}

function entryFilter(q) {
  const where = [];
  const params = [];
  if (q.search) {
    params.push(`%${esc(String(q.search).slice(0, 100))}%`);
    where.push(`(name ILIKE $${params.length} ESCAPE '\\' OR email ILIKE $${params.length} ESCAPE '\\')`);
  }
  const from = parseDate(q.from, 'from');
  const to = parseDate(q.to, 'to');
  if (from) { params.push(from); where.push(`created_at >= $${params.length}`); }
  if (to) { params.push(to); where.push(`created_at <= $${params.length}`); }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

export function createAdminRouter({ db, config }) {
  const r = express.Router();
  const expected = Buffer.from(config.adminKeySha256, 'hex');

  r.use(rateLimit({ windowMs: 15 * 60_000, limit: 30, skipSuccessfulRequests: true, standardHeaders: 'draft-7', legacyHeaders: false,
    store: new DbRateLimitStore({ db, secret: config.formSecret, prefix: 'admin-auth' }),
    message: { ok: false, code: 'TOO_MANY_ATTEMPTS', message: 'Muitas tentativas.' } }));

  r.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const m = /^Bearer ([A-Za-z0-9_\-]{32,200})$/.exec(req.get('authorization') || '');
    const given = crypto.createHash('sha256').update(m ? m[1] : '').digest();
    if (!m || !crypto.timingSafeEqual(given, expected)) {
      return res.status(401).json({ ok: false, code: 'UNAUTHORIZED', message: 'Não autorizado.' });
    }
    const actor = String(req.get('x-admin-actor') || 'admin').replace(/[^\p{L}\p{N}_.@\- ]/gu, '').slice(0, 60) || 'admin';
    req.actor = actor;
    next();
  });
  r.use(express.json({ limit: '64kb' }));

  r.get('/stats', async (_req, res) => {
    const [{ rows: [c] }, { rows: days }, { rows: [d] }, { rows: [s] }] = await Promise.all([
      db.query(`SELECT COUNT(*)::int AS total,
                       COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS last24h,
                       MIN(created_at) AS first_at, MAX(created_at) AS last_at FROM entries`),
      db.query(`SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM-DD') AS day, COUNT(*)::int AS n
                FROM entries WHERE created_at > now() - interval '14 days' GROUP BY 1 ORDER BY 1`),
      db.query(`SELECT d.id, d.drawn_at, d.eligible_count, e.name, e.email FROM draws d JOIN entries e ON e.id = d.entry_id WHERE d.annulled_at IS NULL`),
      db.query('SELECT * FROM settings WHERE id = 1'),
    ]);
    res.json({ ok: true, total: c.total, last24h: c.last24h, firstAt: c.first_at, lastAt: c.last_at, perDay: days,
      activeDraw: d ? { id: d.id, drawnAt: d.drawn_at, eligibleCount: d.eligible_count, name: d.name, email: d.email } : null,
      settings: s });
  });

  r.get('/entries', async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
    const f = entryFilter(req.query);
    const { rows: [{ n }] } = await db.query(`SELECT COUNT(*)::int AS n FROM entries ${f.sql}`, f.params);
    const { rows } = await db.query(
      `SELECT e.id, e.name, e.email, e.created_at,
              EXISTS (SELECT 1 FROM draws d WHERE d.entry_id = e.id AND d.annulled_at IS NULL) AS is_winner
       FROM (SELECT * FROM entries ${f.sql}) e ORDER BY e.created_at DESC, e.id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      f.params);
    res.json({ ok: true, total: n, page, pageSize, items: rows.map((x) => ({ id: x.id, number: pad(x.id), name: x.name, email: x.email, createdAt: x.created_at, isWinner: x.is_winner })) });
  });

  r.get('/entries/export.csv', async (req, res) => {
    const f = entryFilter(req.query);
    const { rows } = await db.query(`SELECT id, name, email, created_at FROM entries ${f.sql} ORDER BY created_at ASC, id ASC LIMIT 500000`, f.params);
    await addAudit(db, req.actor, 'export_csv', { rows: rows.length, search: req.query.search || undefined, from: req.query.from || undefined, to: req.query.to || undefined });
    const lines = ['numero,nome,email,inscrito_em', ...rows.map((x) => [pad(x.id), x.name, x.email, x.created_at].map(csvCell).join(','))];
    res.type('text/csv; charset=utf-8').send('\uFEFF' + lines.join('\r\n') + '\r\n');
  });

  r.get('/settings', async (_req, res) => {
    const { rows: [s] } = await db.query('SELECT * FROM settings WHERE id = 1');
    res.json({ ok: true, settings: s });
  });

  r.put('/settings', async (req, res) => {
    const b = req.body || {};
    const str = (k, max, min = 0) => {
      if (b[k] === undefined) return undefined;
      const v = String(b[k]).trim();
      if (v.length < min || v.length > max) throw new HttpError(422, 'BAD_FIELD', `Campo ${k} inválido (${min}–${max} caracteres).`);
      return v;
    };
    const vals = {
      title: str('title', 120, 3), description: str('description', 2000), prize_name: str('prize_name', 80, 2),
      rules_text: str('rules_text', 20000), organizer_name: str('organizer_name', 120), authorization_number: str('authorization_number', 120),
      contact_email: str('contact_email', 254),
    };
    if (vals.contact_email && !isValidEmail(vals.contact_email.toLowerCase())) throw new HttpError(422, 'BAD_FIELD', 'E-mail de contato inválido.');
    for (const k of ['start_at', 'end_at', 'result_at']) if (b[k] !== undefined) vals[k] = parseDate(b[k], k);
    const result = await db.tx(async (t) => {
      const { rows: [cur] } = await t.query('SELECT * FROM settings WHERE id = 1 FOR UPDATE');
      const next = { ...cur };
      const changed = [];
      for (const [k, v] of Object.entries(vals)) {
        if (v === undefined) continue;
        const a = cur[k] instanceof Date ? cur[k].getTime() : cur[k];
        const c = v instanceof Date ? v.getTime() : v;
        if (a !== c && !(a == null && c == null)) { next[k] = v; changed.push(k); }
      }
      if (next.start_at && next.end_at && new Date(next.end_at) <= new Date(next.start_at)) {
        throw new HttpError(422, 'BAD_DATES', 'A data de encerramento deve ser posterior ao início.');
      }
      if (!changed.length) return { cur, changed };
      await t.query(
        `UPDATE settings SET title=$1, description=$2, prize_name=$3, start_at=$4, end_at=$5, result_at=$6, rules_text=$7,
         organizer_name=$8, contact_email=$9, authorization_number=$10, updated_at=now() WHERE id=1`,
        [next.title, next.description, next.prize_name, next.start_at, next.end_at, next.result_at, next.rules_text, next.organizer_name, next.contact_email, next.authorization_number]);
      await addAudit(t, req.actor, 'settings_update', { fields: changed });
      return { changed };
    });
    const { rows: [s] } = await db.query('SELECT * FROM settings WHERE id = 1');
    res.json({ ok: true, changed: result.changed, settings: s });
  });

  r.post('/registrations/close', async (req, res) => {
    await db.tx(async (t) => {
      await t.query('UPDATE settings SET registrations_closed = true, updated_at = now() WHERE id = 1');
      await addAudit(t, req.actor, 'registrations_close');
    });
    res.json({ ok: true });
  });

  r.post('/registrations/open', async (req, res) => {
    await db.tx(async (t) => {
      // Usa o mesmo lock de inscrição e sorteio para evitar reabertura concorrente.
      await t.query('SELECT id FROM settings WHERE id = 1 FOR UPDATE');
      const { rows } = await t.query('SELECT 1 FROM draws WHERE annulled_at IS NULL');
      if (rows.length) throw new HttpError(409, 'ALREADY_DRAWN', 'Há um sorteio ativo; não é possível reabrir as inscrições.');
      await t.query('UPDATE settings SET registrations_closed = false, updated_at = now() WHERE id = 1');
      await addAudit(t, req.actor, 'registrations_open');
    });
    res.json({ ok: true });
  });

  r.post('/draw', async (req, res) => {
    if (req.body?.confirm !== 'SORTEAR') throw new HttpError(400, 'CONFIRM_REQUIRED', 'Confirmação explícita ausente (digite SORTEAR).');
    const out = await performDraw(db, { actor: req.actor, reason: req.body?.reason });
    res.status(201).json({ ok: true, ...out, winner: { ...out.winner, number: pad(out.winner.entryId) } });
  });

  r.get('/draws', async (_req, res) => {
    const { rows } = await db.query(
      `SELECT d.id, d.drawn_at, d.eligible_count, d.actor, d.reason, d.annulled_at, d.annulled_reason, d.annulled_by,
              e.id AS entry_id, e.name, e.email FROM draws d JOIN entries e ON e.id = d.entry_id ORDER BY d.id DESC`);
    res.json({ ok: true, items: rows.map((x) => ({ id: x.id, drawnAt: x.drawn_at, eligibleCount: x.eligible_count, actor: x.actor, reason: x.reason,
      annulledAt: x.annulled_at, annulledReason: x.annulled_reason, annulledBy: x.annulled_by, entryNumber: pad(x.entry_id), name: x.name, email: x.email })) });
  });

  r.post('/result/publish', async (req, res) => {
    const publish = req.body?.published === true;
    await db.tx(async (t) => {
      if (publish) {
        const { rows } = await t.query('SELECT 1 FROM draws WHERE annulled_at IS NULL');
        if (!rows.length) throw new HttpError(409, 'NO_DRAW', 'Não há sorteio realizado para publicar.');
      }
      await t.query('UPDATE settings SET result_published = $1, updated_at = now() WHERE id = 1', [publish]);
      await addAudit(t, req.actor, publish ? 'result_publish' : 'result_unpublish');
    });
    res.json({ ok: true, published: publish });
  });

  r.get('/audit', async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = 25;
    const { rows: [{ n }] } = await db.query('SELECT COUNT(*)::int AS n FROM audit_log');
    const { rows } = await db.query('SELECT id, at, actor, action, details FROM audit_log ORDER BY id DESC LIMIT $1 OFFSET $2', [pageSize, (page - 1) * pageSize]);
    res.json({ ok: true, total: n, page, pageSize, items: rows });
  });

  return r;
}
export { SETTINGS_PUBLIC_FIELDS };
