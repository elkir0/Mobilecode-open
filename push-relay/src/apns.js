// SPDX-License-Identifier: Apache-2.0
// APNs send helper for the mobilecode-push-relay.
// Uses @parse/node-apn (the maintained fork of node-apn).
//
// The APNs Auth Key (.p8) is loaded from APNS_KEY_PATH at startup — it is NEVER
// stored in source or in the database, only in a mounted/config file.
import fs from 'node:fs';

/**
 * Build an APNs Provider configured from environment variables.
 *
 * Required env:
 *   APNS_KEY_PATH  - absolute path to the .p8 Auth Key (mounted, never committed)
 *   APNS_KEY_ID    - the 10-char Key ID from the Apple Developer portal
 *   APNS_TEAM_ID   - the 10-char Team ID
 *   APNS_PRODUCTION- 'false' to use the development gateway; anything else => production
 *
 * @returns {Promise<{provider: import('@parse/node-apn').Provider, bundleId: string}>}
 */
export async function buildApns() {
  const keyPath = process.env.APNS_KEY_PATH;
  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;
  const bundleId = process.env.APNS_BUNDLE_ID;
  const production = (process.env.APNS_PRODUCTION ?? 'true') !== 'false';

  if (!keyPath || !keyId || !teamId || !bundleId) {
    throw new Error(
      'APNs not configured: APNS_KEY_PATH, APNS_KEY_ID, APNS_TEAM_ID and APNS_BUNDLE_ID must all be set.'
    );
  }
  if (!fs.existsSync(keyPath)) {
    throw new Error(`APNS_KEY_PATH points to a non-existent file: ${keyPath}`);
  }

  // Lazy import so the dependency is only required when APNs is actually used.
  const apn = await import('@parse/node-apn');

  const provider = new apn.Provider({
    token: {
      key: fs.readFileSync(keyPath),
      keyId,
      teamId,
    },
    production,
  });

  return { provider, bundleId };
}

/**
 * Send one push to a single device token.
 *
 * @param {object} opts
 * @param {import('@parse/node-apn').Provider} opts.provider
 * @param {string} opts.bundleId  - app bundle id (APNs topic)
 * @param {string} opts.token     - 64-hex device token
 * @param {string} [opts.title]
 * @param {string} [opts.body]
 * @param {object} [opts.data]    - custom payload merged into aps / root
 * @returns {Promise<{sent: boolean, status: number, reason?: string}>}
 */
export async function sendApns({ provider, bundleId, token, title, body, data }) {
  const apn = await import('@parse/node-apn');

  const note = new apn.Notification();
  note.pushType = 'alert';
  note.topic = bundleId;
  note.sound = 'default';
  if (title || body) {
    note.alert = { title: title || '', body: body || '' };
  }
  // Custom data: merge at the root level (APNs allows arbitrary keys alongside `aps`).
  if (data && typeof data === 'object') {
    for (const [k, v] of Object.entries(data)) {
      // Avoid clobbering the aps dictionary.
      if (k === 'aps') continue;
      try {
        note.payload = note.payload || {};
        note.payload[k] = v;
      } catch {
        /* ignore unserialisable values */
      }
    }
  }

  try {
    const res = await provider.send(note, token);
    const sent = Array.isArray(res.sent) && res.sent.some((s) => s.device === token);
    const failed = Array.isArray(res.failed) ? res.failed[0] : null;
    const status = sent ? 200 : failed?.status ?? 0;
    const reason = failed?.response?.reason;
    return { sent: !!sent, status, reason };
  } catch (err) {
    return { sent: false, status: 0, reason: String(err?.message || err) };
  }
}
