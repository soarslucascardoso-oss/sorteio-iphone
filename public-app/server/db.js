// Camada de banco: PostgreSQL (produção, via DATABASE_URL) ou PGlite (Postgres embarcado,
// para desenvolvimento e testes). O SQL é o mesmo nos dois casos.
import pg from 'pg';

export async function createDb({ databaseUrl, dataDir } = {}) {
  if (databaseUrl) {
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      max: Number(process.env.DB_POOL_MAX || 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    pool.on('error', (e) => console.error(JSON.stringify({ level: 'error', msg: 'pg pool error', code: e.code })));
    return {
      kind: 'postgres',
      query: (sql, params = []) => pool.query(sql, params),
      exec: (sql) => pool.query(sql),
      async tx(fn) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const out = await fn({ query: (s, p = []) => client.query(s, p), exec: (s) => client.query(s) });
          await client.query('COMMIT');
          return out;
        } catch (e) {
          try { await client.query('ROLLBACK'); } catch { /* ignora */ }
          throw e;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const lite = new PGlite(dataDir || 'memory://');
  await lite.waitReady;
  return {
    kind: 'pglite',
    query: (sql, params = []) => lite.query(sql, params),
    exec: (sql) => lite.exec(sql),
    tx: (fn) => lite.transaction((t) => fn({ query: (s, p = []) => t.query(s, p), exec: (s) => t.exec(s) })),
    close: () => lite.close(),
  };
}
