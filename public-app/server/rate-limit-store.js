import crypto from 'node:crypto';

// Store compartilhado entre instâncias, com chaves HMAC (não grava IP em texto puro).
export class DbRateLimitStore {
  constructor({ db, secret, prefix = 'api', cleanupEvery = 1000 }) {
    this.db = db;
    this.secret = secret;
    this.prefix = prefix;
    this.cleanupEvery = cleanupEvery;
    this.windowMs = 60_000;
    this.calls = 0;
  }

  init(options) { this.windowMs = options.windowMs; }

  key(value) {
    return crypto.createHmac('sha256', this.secret)
      .update(`${this.prefix}:${value}`)
      .digest('hex');
  }

  async increment(key) {
    const hashed = this.key(key);
    const { rows: [row] } = await this.db.query(
      `INSERT INTO rate_limits (bucket_key, hits, reset_at)
       VALUES ($1, 1, now() + ($2::double precision * interval '1 millisecond'))
       ON CONFLICT (bucket_key) DO UPDATE SET
         hits = CASE WHEN rate_limits.reset_at <= now() THEN 1 ELSE rate_limits.hits + 1 END,
         reset_at = CASE WHEN rate_limits.reset_at <= now()
           THEN now() + ($2::double precision * interval '1 millisecond')
           ELSE rate_limits.reset_at END
       RETURNING hits, reset_at`,
      [hashed, this.windowMs],
    );
    this.calls += 1;
    if (this.calls % this.cleanupEvery === 0) {
      await this.db.query("DELETE FROM rate_limits WHERE reset_at < now() - interval '1 hour'");
    }
    return { totalHits: Number(row.hits), resetTime: new Date(row.reset_at) };
  }

  async get(key) {
    const { rows: [row] } = await this.db.query(
      'SELECT hits, reset_at FROM rate_limits WHERE bucket_key = $1', [this.key(key)],
    );
    if (!row || new Date(row.reset_at).getTime() <= Date.now()) return undefined;
    return { totalHits: Number(row.hits), resetTime: new Date(row.reset_at) };
  }

  async decrement(key) {
    await this.db.query(
      'UPDATE rate_limits SET hits = GREATEST(hits - 1, 0) WHERE bucket_key = $1', [this.key(key)],
    );
  }

  async resetKey(key) {
    await this.db.query('DELETE FROM rate_limits WHERE bucket_key = $1', [this.key(key)]);
  }
}
