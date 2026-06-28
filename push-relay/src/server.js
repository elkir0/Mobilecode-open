// SPDX-License-Identifier: Apache-2.0
// mobilecode-push-relay — minimal APNs-only push notification relay.
//
// What this server holds:
//   - the APNs Auth Key (.p8, from a mounted file, NEVER in source/DB)
//   - device tokens (per api key, in SQLite)
//   - api keys (stored HASHED — sha256 — in SQLite)
//
// What this server NEVER holds:
//   - opencode credentials, Basic Auth passwords, Tailscale keys, etc.
//   The OpenCodeBar watcher / iOS app only talk to this relay with an api key.
//
// Auth model:
//   - Normal callers (iOS app register/unregister, watcher push) use a Bearer api
//     key of the form `mpr_<64hex>`. The plaintext is shown ONCE at creation and
//     never stored; only its sha256 hash is persisted.
//   - Admin routes (/admin/api-keys) use the ADMIN_SECRET from env.
import express from 'express';
import { createHash, randomUUID, randomBytes } from 'node:crypto';

import { openDb } from './db.js';
import { buildApns, sendApns } from './apns.js';

const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.DB_PATH || './data/relay.db';
const ADMIN_SECRET = process.env.ADMIN_SECRET;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
// Simple in-process rate limit state for /push (per api key).
const PUSH_RATE_WINDOW_MS = 60_000;
const PUSH_RATE_MAX = Number(process.env.PUSH_RATE_MAX ?? 60);

if (!ADMIN_SECRET) {
  console.error('FATAL: ADMIN_SECRET env var is required. Copy .env.example to .env and set it.');
  process.exit(1);
}

// --- helpers ---------------------------------------------------------------

function sha256(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/**
 * Extract + validate a Bearer api key from the request.
 * Returns the matching api_key row, or null.
 */
function authApiKey(req, db) {
  const header = req.header('authorization') || '';
  const m = /^Bearer\s+(mpr_[0-9a-f]{64})$/i.exec(header);
  if (!m) return null;
  const hash = sha256(m[1]);
  return db.prepare('SELECT id, name FROM api_keys WHERE key_hash = ?').get(hash) || null;
}

function isAdmin(req) {
  const header = req.header('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return !!(m && m[1] === ADMIN_SECRET);
}

// In-process sliding rate limiter for /push (keyed by api_key id).
const pushHits = new Map(); // api_key_id -> [timestamps]
function rateLimitPush(apiKeyId) {
  const now = Date.now();
  const arr = (pushHits.get(apiKeyId) || []).filter((t) => now - t < PUSH_RATE_WINDOW_MS);
  if (arr.length >= PUSH_RATE_MAX) return false;
  arr.push(now);
  pushHits.set(apiKeyId, arr);
  return true;
}

function tinyLog(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
}

// --- app bootstrap ---------------------------------------------------------

async function main() {
  const db = openDb(DB_PATH);

  // APNs is optional at boot only so admin routes (api-key management) work
  // before APNs is configured. /push will 503 if APNs isn't ready.
  let apns = null;
  try {
    apns = await buildApns();
    console.log(`APNs ready (bundle=${apns.bundleId}, production=${process.env.APNS_PRODUCTION !== 'false'})`);
  } catch (err) {
    console.warn(`APNs not configured yet: ${err.message}. /push will return 503 until env is set.`);
  }

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  // Manual security headers (no helmet dep — keeps the surface tiny).
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('Cache-Control', 'no-store');
    if (CORS_ORIGIN !== '*') {
      res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
      res.setHeader('Vary', 'Origin');
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.use(tinyLog);

  // --- health -------------------------------------------------------------
  app.get('/health', (_req, res) => res.json({ ok: true, apns: !!apns }));

  // --- device registration (api key auth) ---------------------------------
  app.post('/register', (req, res) => {
    const key = authApiKey(req, db);
    if (!key) return res.status(401).json({ error: 'unauthorized' });

    const { token, bundleId } = req.body || {};
    if (typeof token !== 'string' || !/^[0-9a-f]{64}$/i.test(token)) {
      return res.status(400).json({ error: 'invalid token (expected 64-hex device token)' });
    }
    db.prepare(
      `INSERT INTO devices (api_key_id, token, bundle_id, created)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(api_key_id, token) DO UPDATE SET bundle_id = excluded.bundle_id`
    ).run(key.id, token.toLowerCase(), typeof bundleId === 'string' ? bundleId : null, Date.now());
    res.json({ ok: true });
  });

  app.delete('/register', (req, res) => {
    const key = authApiKey(req, db);
    if (!key) return res.status(401).json({ error: 'unauthorized' });

    const { token } = req.body || {};
    if (typeof token !== 'string') return res.status(400).json({ error: 'invalid token' });
    db.prepare('DELETE FROM devices WHERE api_key_id = ? AND token = ?').run(key.id, token.toLowerCase());
    res.json({ ok: true });
  });

  // --- push (api key auth) ------------------------------------------------
  app.post('/push', async (req, res) => {
    const key = authApiKey(req, db);
    if (!key) return res.status(401).json({ error: 'unauthorized' });
    if (!apns) return res.status(503).json({ error: 'APNs not configured on the relay' });
    if (!rateLimitPush(key.id)) {
      return res.status(429).json({ error: 'rate limit exceeded', limit: PUSH_RATE_MAX, windowMs: PUSH_RATE_WINDOW_MS });
    }

    const { token, title, body, data } = req.body || {};
    let targets;
    if (token) {
      if (!/^[0-9a-f]{64}$/i.test(token)) {
        return res.status(400).json({ error: 'invalid token (expected 64-hex device token)' });
      }
      const row = db
        .prepare('SELECT token FROM devices WHERE api_key_id = ? AND token = ?')
        .get(key.id, token.toLowerCase());
      targets = row ? [row.token] : [];
    } else {
      targets = db.prepare('SELECT token FROM devices WHERE api_key_id = ?').all(key.id).map((r) => r.token);
    }

    if (targets.length === 0) {
      return res.json({ sent: 0, failed: 0, note: 'no registered devices for this api key' });
    }

    let sent = 0;
    const failed = [];
    const toDelete = [];
    for (const t of targets) {
      const r = await sendApns({
        provider: apns.provider,
        bundleId: apns.bundleId,
        token: t,
        title,
        body,
        data,
      });
      if (r.sent) {
        sent++;
      } else {
        failed.push({ token: t, status: r.status, reason: r.reason });
        // 410 Unregistered / 404 BadDeviceToken => prune the stale token.
        if (r.status === 410 || r.status === 404) toDelete.push(t);
      }
    }
    if (toDelete.length) {
      const del = db.prepare('DELETE FROM devices WHERE api_key_id = ? AND token = ?');
      for (const t of toDelete) del.run(key.id, t);
    }

    res.json({ sent, failed });
  });

  // --- admin: api key management (ADMIN_SECRET auth) ----------------------
  app.post('/admin/api-keys', (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'unauthorized' });
    const { name } = req.body || {};
    if (typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ error: 'name required' });
    }
    const id = randomUUID();
    const plaintext = 'mpr_' + randomBytes(32).toString('hex');
    const keyHash = sha256(plaintext);
    db.prepare(
      'INSERT INTO api_keys (id, name, key_hash, created) VALUES (?, ?, ?, ?)'
    ).run(id, name.trim(), keyHash, Date.now());
    // Plaintext is returned EXACTLY ONCE. Store it nowhere.
    return res.status(201).json({ id, name: name.trim(), key: plaintext, createdAt: new Date().toISOString() });
  });

  app.get('/admin/api-keys', (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'unauthorized' });
    const rows = db
      .prepare('SELECT id, name, key_hash, created FROM api_keys ORDER BY created DESC')
      .all()
      .map((r) => ({ id: r.id, name: r.name, keyHash: r.key_hash, createdAt: new Date(r.created).toISOString() }));
    return res.json({ keys: rows });
  });

  app.delete('/admin/api-keys/:id', (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'unauthorized' });
    const info = db.prepare('DELETE FROM api_keys WHERE id = ?').run(req.params.id);
    // Cascade: drop that key's registered devices too.
    db.prepare('DELETE FROM devices WHERE api_key_id = ?').run(req.params.id);
    if (info.changes === 0) return res.status(404).json({ error: 'not found' });
    return res.json({ ok: true });
  });

  app.use((req, res) => res.status(404).json({ error: 'not found' }));

  // Centralised error handler — never leak stack traces.
  app.use((err, _req, res, _next) => {
    console.error(err);
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'payload too large' });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid json' });
    res.status(500).json({ error: 'internal' });
  });

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`mobilecode-push-relay listening on 0.0.0.0:${PORT} (db=${DB_PATH})`);
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
