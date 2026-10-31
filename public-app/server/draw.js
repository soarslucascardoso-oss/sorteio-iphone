import crypto from 'node:crypto';
import { HttpError, registrationState } from './validation.js';

const ELIGIBLE_SQL = `
  FROM entries e
  WHERE e.status = 'valid'
    AND ($1::timestamptz IS NULL OR e.created_at >= $1)
    AND ($2::timestamptz IS NULL OR e.created_at <= $2)
    AND NOT EXISTS (SELECT 1 FROM draws d WHERE d.entry_id = e.id)`;

export async function addAudit(q, actor, action, details = {}) {
  await q.query('INSERT INTO audit_log (actor, action, details) VALUES ($1, $2, $3::jsonb)', [actor || '', action, JSON.stringify(details)]);
}

// Executa o sorteio no servidor, dentro de uma transação, com trava na linha de configurações.
export async function performDraw(db, { actor, reason }) {
  return db.tx(async (t) => {
    const { rows: [s] } = await t.query('SELECT * FROM settings WHERE id = 1 FOR UPDATE');
    const state = registrationState(s);
    if (state === 'open' || state === 'not_started') {
      throw new HttpError(409, 'REGISTRATIONS_OPEN', 'Encerre as inscrições antes de executar o sorteio.');
    }
    const { rows: [active] } = await t.query('SELECT id, entry_id FROM draws WHERE annulled_at IS NULL FOR UPDATE');
    let redraw = false;
    if (active) {
      const why = String(reason || '').trim();
      if (why.length < 10) {
        throw new HttpError(409, 'ALREADY_DRAWN', 'Já existe um sorteio ativo. Para sortear novamente, informe uma justificativa (mín. 10 caracteres).');
      }
      await t.query('UPDATE draws SET annulled_at = now(), annulled_reason = $1, annulled_by = $2 WHERE id = $3', [why.slice(0, 500), actor || '', active.id]);
      redraw = true;
    }
    const { rows: [{ n }] } = await t.query(`SELECT COUNT(*)::int AS n ${ELIGIBLE_SQL}`, [s.start_at, s.end_at]);
    if (n === 0) throw new HttpError(409, 'NO_ELIGIBLE', 'Não há inscrições elegíveis para o sorteio.');
    const idx = crypto.randomInt(n); // CSPRNG, uniforme
    const { rows: [w] } = await t.query(
      `SELECT e.id, e.name, e.email, e.created_at ${ELIGIBLE_SQL} ORDER BY e.id OFFSET $3 LIMIT 1`,
      [s.start_at, s.end_at, idx],
    );
    const { rows: [d] } = await t.query(
      `INSERT INTO draws (entry_id, eligible_count, picked_index, actor, reason)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, drawn_at`,
      [w.id, n, idx, actor || '', redraw ? String(reason).trim().slice(0, 500) : ''],
    );
    await addAudit(t, actor, redraw ? 'draw_redo' : 'draw', { drawId: d.id, entryId: w.id, eligible: n, reason: redraw ? String(reason).trim().slice(0, 500) : undefined });
    // Um novo sorteio despublica o resultado anterior.
    if (redraw) await t.query('UPDATE settings SET result_published = false, updated_at = now() WHERE id = 1');
    return { drawId: d.id, drawnAt: d.drawn_at, eligibleCount: n, redraw, winner: { entryId: w.id, name: w.name, email: w.email, createdAt: w.created_at } };
  });
}
