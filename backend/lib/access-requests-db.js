// backend/lib/access-requests-db.js
//
// Postgres helpers for the self-serve access request flow.
// The UPDATE…WHERE status='pending' pattern gives atomic first-click-wins
// without any application-level locking.

import crypto from 'node:crypto';
import { query } from './db.js';

export function newRequestId() {
  return crypto.randomUUID();
}

/**
 * Insert a new pending access request. Returns the inserted row.
 */
export async function createAccessRequest({ id, name, email, reason }) {
  const { rows } = await query(
    `INSERT INTO access_requests (id, name, email, reason)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [id, name, email, reason || null],
  );
  return rows[0];
}

/**
 * Fetch a single request by id.
 */
export async function getAccessRequest(id) {
  const { rows } = await query(
    'SELECT * FROM access_requests WHERE id = $1',
    [id],
  );
  return rows[0] || null;
}

/**
 * Attempt to mark a request decided (approve | deny).
 * Returns the updated row if this call won, or null if someone already decided.
 */
export async function markAccessRequestDecided(id, action, decidedBy) {
  const status = action === 'approve' ? 'approved' : 'denied';
  const { rows } = await query(
    `UPDATE access_requests
     SET status = $2, decided_at = NOW(), decided_by = $3, decided_action = $4
     WHERE id = $1 AND status = 'pending'
     RETURNING *`,
    [id, status, decidedBy, action],
  );
  return rows[0] || null;
}
