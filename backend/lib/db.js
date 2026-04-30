import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}

// SSL gating, in priority order:
//   1. PGSSL env var (explicit operator intent)
//      - "disable"                -> no TLS
//      - "require" | "no-verify"  -> TLS, accept self-signed (Railway public proxy, Heroku, etc.)
//      - "verify-full"            -> TLS, must verify the chain
//   2. sslmode= in DATABASE_URL (the pg driver does not honor this on its own)
//   3. Default: no TLS. Railway's *.railway.internal hostname does not negotiate TLS,
//      so we must not force it on by default.
function resolveSsl() {
  const mode = (process.env.PGSSL || '').toLowerCase();
  if (mode === 'disable') return false;
  if (mode === 'require' || mode === 'no-verify') return { rejectUnauthorized: false };
  if (mode === 'verify-full') return { rejectUnauthorized: true };

  const url = process.env.DATABASE_URL || '';
  const m = url.match(/[?&]sslmode=([a-z-]+)/i);
  if (m) {
    const sm = m[1].toLowerCase();
    if (sm === 'disable' || sm === 'allow' || sm === 'prefer') return false;
    if (sm === 'require') return { rejectUnauthorized: false };
    if (sm === 'verify-ca' || sm === 'verify-full') return { rejectUnauthorized: true };
  }

  return false;
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: resolveSsl(),
});

export async function query(text, params) {
  return pool.query(text, params);
}

export async function runMigrations() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const migrationsDir = path.resolve(__dirname, '..', 'migrations');
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

  // Bootstrap the tracking table outside the per-file loop so a fresh database survives.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT        PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const { rows } = await pool.query('SELECT filename FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.filename));

  for (const file of files) {
    if (applied.has(file)) {
      // Debug-level so steady-state boots stay terse. Surface with LOG_LEVEL=debug or NODE_DEBUG.
      console.debug(`[db] migration skipping (already applied): ${file}`);
      continue;
    }
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (filename) VALUES ($1)',
        [file],
      );
      await client.query('COMMIT');
      console.log(`[db] migration applied: ${file}`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}
