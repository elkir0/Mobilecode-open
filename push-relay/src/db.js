// SPDX-License-Identifier: Apache-2.0
// SQLite layer for the mobilecode-push-relay.
// Holds ONLY: hashed api keys, device tokens, bundle ids. Never sees opencode creds.
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Open (and migrate) the relay database.
 * @param {string} dbPath - filesystem path to the SQLite file.
 * @returns {import('better-sqlite3').Database}
 */
export function openDb(dbPath) {
  const abs = resolve(dbPath);
  const dir = dirname(abs);
  if (dir) mkdirSync(dir, { recursive: true });

  const db = new Database(abs);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id        TEXT PRIMARY KEY,
      name      TEXT NOT NULL,
      key_hash  TEXT NOT NULL UNIQUE,
      created   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS devices (
      api_key_id  TEXT NOT NULL,
      token       TEXT NOT NULL,
      bundle_id   TEXT,
      created     INTEGER NOT NULL,
      PRIMARY KEY (api_key_id, token)
    );
    CREATE INDEX IF NOT EXISTS idx_devices_api_key ON devices(api_key_id);
  `);

  return db;
}
