import crypto from 'node:crypto';

// Formato: scrypt:N:r:p:salt(b64):hash(b64)  (sem "$" para não ser mal interpretado em arquivos .env)
export function hashPassword(password, { N = 32768, r = 8, p = 1 } = {}) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N, r, p, maxmem: 128 * N * r * 2 });
  return ['scrypt', N, r, p, salt.toString('base64'), hash.toString('base64')].join(':');
}

export function verifyPassword(password, stored) {
  const parts = String(stored || '').split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64');
  const got = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p, maxmem: 128 * +N * +r * 2 });
  return crypto.timingSafeEqual(got, expected);
}

export class SessionStore {
  constructor({ idleMs, maxMs }) { this.idleMs = idleMs; this.maxMs = maxMs; this.map = new Map(); }
  create(user) {
    const id = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    this.map.set(id, { user, csrf: crypto.randomBytes(24).toString('base64url'), createdAt: now, lastSeen: now });
    return { id, ...this.map.get(id) };
  }
  get(id) {
    const s = id && this.map.get(id);
    if (!s) return null;
    const now = Date.now();
    if (now - s.lastSeen > this.idleMs || now - s.createdAt > this.maxMs) { this.map.delete(id); return null; }
    s.lastSeen = now;
    return s;
  }
  destroy(id) { this.map.delete(id); }
  sweep() { for (const id of [...this.map.keys()]) this.get(id); }
}

// Bloqueio de força bruta: após `max` falhas na janela, bloqueia por `lockMs`.
export class LoginLimiter {
  constructor({ max = 5, windowMs = 15 * 60_000, lockMs = 15 * 60_000 } = {}) { Object.assign(this, { max, windowMs, lockMs }); this.fails = []; this.lockedUntil = 0; }
  retryAfterMs(now = Date.now()) { return Math.max(0, this.lockedUntil - now); }
  fail(now = Date.now()) {
    this.fails = this.fails.filter((t) => now - t < this.windowMs); this.fails.push(now);
    if (this.fails.length >= this.max) { this.lockedUntil = now + this.lockMs; this.fails = []; }
  }
  success() { this.fails = []; this.lockedUntil = 0; }
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
