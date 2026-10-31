import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createAdminRouter } from './admin.js';
import { DbRateLimitStore } from './rate-limit-store.js';
import {
  HttpError, validateEntry, makeFormToken, checkFormToken, registrationState, pad, maskName,
} from './validation.js';

export const SUCCESS_MESSAGE = 'Inscrição realizada com sucesso! Você está inscrito para o sorteio. Boa sorte!';
const jsonErr = (code, message) => ({ ok: false, code, message });

async function verifyTurnstile(secret, token, ip) {
  if (typeof token !== 'string' || !token || token.length > 2048) return false;
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token, ...(ip ? { remoteip: ip } : {}) }),
      signal: AbortSignal.timeout(5000),
    });
    return (await r.json()).success === true;
  } catch { return false; }
}

export function createApp({ db, config }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  const ts = config.turnstileSiteKey ? ['https://challenges.cloudflare.com'] : [];
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'", ...ts], styleSrc: ["'self'"], imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", ...ts], frameSrc: [...ts], formAction: ["'self'"], frameAncestors: ["'none'"],
        objectSrc: ["'none'"], baseUri: ["'self'"], upgradeInsecureRequests: config.isProd ? [] : null,
      },
    },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    strictTransportSecurity: config.isProd ? { maxAge: 31536000, includeSubDomains: true } : false,
  }));

  app.get('/healthz', async (_req, res) => {
    try { await db.query('SELECT 1'); res.set('Cache-Control', 'no-store').json({ ok: true }); }
    catch { res.status(503).json({ ok: false }); }
  });

  // Painel administrativo NÃO faz parte deste serviço.
  app.all(['/admin', '/admin/{*rest}'], (_req, res) => res.status(404).type('text/plain').send('Não encontrado'));

  if (config.adminKeySha256) app.use('/internal/admin', createAdminRouter({ db, config }));
  else app.all('/internal/admin/{*rest}', (_req, res) => res.status(404).json(jsonErr('NOT_FOUND', 'Não encontrado.')));

  const general = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false,
    store: new DbRateLimitStore({ db, secret: config.formSecret, prefix: 'public-general' }),
    message: jsonErr('RATE_LIMITED', 'Muitas requisições. Aguarde um instante.') });
  const entriesLimiter = rateLimit({ windowMs: 15 * 60_000, limit: config.entriesPerWindow, standardHeaders: 'draft-7', legacyHeaders: false,
    store: new DbRateLimitStore({ db, secret: config.formSecret, prefix: 'public-entries' }),
    message: jsonErr('RATE_LIMITED', 'Muitas tentativas de inscrição. Tente novamente em alguns minutos.') });

  const getSettings = async () => (await db.query('SELECT * FROM settings WHERE id = 1')).rows[0];

  app.get('/api/public/config', general, async (_req, res) => {
    const s = await getSettings();
    res.set('Cache-Control', 'no-store').json({
      ok: true, title: s.title, description: s.description, prizeName: s.prize_name,
      startAt: s.start_at, endAt: s.end_at, resultAt: s.result_at, state: registrationState(s),
      resultPublished: s.result_published, rulesText: s.rules_text, organizerName: s.organizer_name,
      contactEmail: s.contact_email, authorizationNumber: s.authorization_number,
      formToken: makeFormToken(config.formSecret), turnstileSiteKey: config.turnstileSiteKey || null,
    });
  });

  app.get('/api/public/result', general, async (_req, res) => {
    const s = await getSettings();
    res.set('Cache-Control', 'no-store');
    if (!s.result_published) return res.json({ ok: true, published: false, resultAt: s.result_at });
    const { rows: [d] } = await db.query(
      'SELECT d.drawn_at, d.eligible_count, e.id, e.name FROM draws d JOIN entries e ON e.id = d.entry_id WHERE d.annulled_at IS NULL');
    if (!d) return res.json({ ok: true, published: false, resultAt: s.result_at });
    res.json({ ok: true, published: true, drawnAt: d.drawn_at, eligibleCount: d.eligible_count, winner: { entryNumber: pad(d.id), maskedName: maskName(d.name) } });
  });

  function sameOrigin(req, res, next) {
    const origin = req.get('origin');
    if (origin) {
      let ok = config.allowedOrigins.includes(origin);
      try { ok = ok || new URL(origin).host === req.get('host'); } catch { ok = false; }
      if (!ok) return res.status(403).json(jsonErr('BAD_ORIGIN', 'Origem não permitida.'));
    }
    if (!req.is('application/json')) return res.status(415).json(jsonErr('BAD_CONTENT_TYPE', 'Content-Type deve ser application/json.'));
    next();
  }

  app.post('/api/entries', entriesLimiter, sameOrigin, express.json({ limit: '4kb', strict: true }), async (req, res) => {
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    if (typeof b.website === 'string' && b.website !== '') { // honeypot: robôs recebem "sucesso" falso
      return res.status(201).json({ ok: true, entryNumber: '000000', message: SUCCESS_MESSAGE });
    }
    if (!checkFormToken(b.formToken, config.formSecret, { minSeconds: config.minFormSeconds })) {
      throw new HttpError(400, 'FORM_EXPIRED', 'Não foi possível validar o envio. Atualize a página e tente novamente.');
    }
    if (config.turnstileSecret && !(await verifyTurnstile(config.turnstileSecret, b.turnstileToken, req.ip))) {
      throw new HttpError(400, 'CAPTCHA_FAILED', 'Falha na verificação anti-robô. Tente novamente.');
    }
    const v = validateEntry(b);
    if (!v.ok) throw new HttpError(422, 'VALIDATION', 'Verifique os campos informados.', { errors: v.errors });

    // Serializa inscrição, encerramento e sorteio pela mesma linha de settings.
    // Assim, uma inscrição não pode passar pela checagem e gravar após o fechamento.
    const inserted = await db.tx(async (t) => {
      const { rows: [s] } = await t.query('SELECT * FROM settings WHERE id = 1 FOR UPDATE');
      const state = registrationState(s);
      if (state !== 'open') {
        const msg = state === 'not_started' ? 'As inscrições ainda não foram abertas.' : 'As inscrições estão encerradas.';
        throw new HttpError(403, 'REGISTRATIONS_' + state.toUpperCase(), msg);
      }
      const { rows } = await t.query(
        `INSERT INTO entries (name, email, email_normalized) VALUES ($1, $2, $2)
         ON CONFLICT (email_normalized) DO NOTHING RETURNING id, created_at`, [v.name, v.email]);
      if (!rows.length) throw new HttpError(409, 'EMAIL_DUPLICATE', 'Este e-mail já está inscrito no sorteio.');
      return rows[0];
    });
    res.status(201).json({ ok: true, entryNumber: pad(inserted.id), createdAt: inserted.created_at, message: SUCCESS_MESSAGE });
  });

  app.use('/api', (_req, res) => res.status(404).json(jsonErr('NOT_FOUND', 'Não encontrado.')));

  app.use(express.static(config.publicDir, {
    extensions: ['html'], index: 'index.html', dotfiles: 'ignore', maxAge: config.isProd ? '1h' : 0,
    setHeaders(res, p) { if (p.endsWith('.html')) res.set('Cache-Control', 'no-cache'); },
  }));
  app.use((_req, res) => res.status(404).type('text/plain').send('Página não encontrada'));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ ...jsonErr(err.code, err.message), ...err.extra });
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large' || err.type === 'charset.unsupported') {
      return res.status(err.status || 400).json(jsonErr('BAD_REQUEST', 'Requisição inválida.'));
    }
    // Log sem dados pessoais: somente rota e código do erro.
    console.error(JSON.stringify({ level: 'error', msg: String(err.message).slice(0, 200), code: err.code, method: req.method, path: req.path }));
    res.status(500).json(jsonErr('INTERNAL', 'Erro interno. Tente novamente em instantes.'));
  });

  return app;
}
