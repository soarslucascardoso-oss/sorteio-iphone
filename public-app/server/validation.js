import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M}'’.\- ]*$/u;
const EMAIL_PART = /^[^\s@<>()[\]\\,;:"]+$/;

export function normalizeName(v) {
  return String(v ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
}
export function normalizeEmail(v) {
  return String(v ?? '').normalize('NFKC').trim().toLowerCase();
}

export function isValidEmail(e) {
  if (e.length < 6 || e.length > 254) return false;
  const at = e.lastIndexOf('@');
  if (at < 1) return false;
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  if (local.length > 64 || e.split('@').length !== 2) return false;
  if (!EMAIL_PART.test(local) || !EMAIL_PART.test(domain)) return false;
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  const labels = domain.split('.');
  if (labels.length < 2 || labels.some((l) => !l || l.length > 63 || l.startsWith('-') || l.endsWith('-'))) return false;
  return /^[a-z]{2,}$/i.test(labels.at(-1)) || /^xn--[a-z0-9-]+$/i.test(labels.at(-1));
}

export function validateEntry(body) {
  const errors = {};
  const name = normalizeName(body.name);
  const email = normalizeEmail(body.email);
  if (typeof body.name !== 'string' || name.length < 5 || name.length > 120 || !NAME_RE.test(name) || name.split(' ').length < 2) {
    errors.name = 'Informe seu nome completo (nome e sobrenome), apenas com letras.';
  }
  if (typeof body.email !== 'string' || !isValidEmail(email)) errors.email = 'Informe um e-mail válido.';
  if (body.consent !== true) errors.consent = 'É necessário concordar com o regulamento e a Política de Privacidade.';
  return { ok: Object.keys(errors).length === 0, errors, name, email };
}

const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('base64url');

export function makeFormToken(secret, now = Date.now()) {
  const ts = String(now);
  return `${ts}.${hmac(secret, ts)}`;
}

export function checkFormToken(token, secret, { minSeconds, maxSeconds = 7200 }, now = Date.now()) {
  if (typeof token !== 'string') return false;
  const [ts, sig] = token.split('.');
  if (!ts || !sig || !/^\d{10,15}$/.test(ts)) return false;
  const expected = hmac(secret, ts);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const age = (now - Number(ts)) / 1000;
  return age >= minSeconds && age <= maxSeconds;
}

export function registrationState(s, now = new Date()) {
  if (s.registrations_closed) return 'closed';
  if (s.start_at && now < new Date(s.start_at)) return 'not_started';
  if (s.end_at && now > new Date(s.end_at)) return 'ended';
  return 'open';
}

export const pad = (n) => String(n).padStart(6, '0');
export const maskName = (n) => String(n).split(' ').filter(Boolean).map((w) => [...w][0] + '***').join(' ');
