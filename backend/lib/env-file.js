/*
 * Loads the repo-root `.env` (one level above backend/) for local runs.
 *
 * Railway never sees that file — only the backend/ directory is deployed — so
 * every name this file can provide must also be set on the Railway service.
 * Values already present in the process environment are never overwritten.
 *
 * Import this module FIRST in server.js: it must evaluate before any module
 * that reads process.env at import time (lib/db.js, lib/admin-jwt.js).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ENV_PATH = path.resolve(__dirname, '..', '..', '.env');

export function loadRepoEnv(envPath = REPO_ENV_PATH, env = process.env) {
  let raw;
  try {
    raw = fs.readFileSync(envPath, 'utf8');
  } catch {
    return {}; // No repo-root .env (e.g. Railway) — nothing to load.
  }

  const loaded = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in env)) {
      env[key] = value;
      loaded[key] = value;
    }
  }
  return loaded;
}

loadRepoEnv();