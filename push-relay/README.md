# mobilecode-push-relay

A minimal, open-source, **APNs-only** push-notification relay for the
[Mobilecode-open](../) iOS app. It is a small public server with three jobs:

1. let the iOS app **register** its APNs device token,
2. let an authenticated caller (the **OpenCodeBar watcher** on your Mac, or any
   script) **request a push**,
3. **send the push to Apple APNs** using a single Apple Auth Key.

## Architecture

```
   iPhone (Mobilecode-open)              this relay (push.shathony.fr)            Apple APNs
   ┌──────────────────────┐              ┌─────────────────────────────┐         ┌──────────┐
   │  POST /register      │ ──token──▶   │  api keys (HASHED, SQLite)   │         │          │
   │  DELETE /register    │              │  device tokens (SQLite)      │  .p8 →  │  push    │
   └──────────────────────┘              │  APNs Auth Key (.p8, mounted)│ ──────▶ │          │
                                          └─────────────────────────────┘         └──────────┘
   OpenCodeBar watcher (your Mac)              ▲
   ┌──────────────────────┐                    │ mpr_... api key (Bearer)
   │  POST /push          │ ───────────────────┘
   └──────────────────────┘
```

**What the relay holds** (and only this):

- the **APNs Auth Key** (`.p8`) — loaded from a mounted file at startup,
  never written to the database, never in source.
- **device tokens**, scoped per api key.
- **api keys**, stored **hashed** (sha256). The plaintext is shown **once** at
  creation and never persisted.

**What the relay NEVER holds:**

- opencode credentials, Basic-Auth passwords, Tailscale keys, or anything else
  from the iOS app or the opencode server. The app and the watcher only ever
  talk to the relay with an api key. If the relay is compromised, the worst an
  attacker gets is the ability to send pushes — not your opencode session.

## Endpoints

All non-admin routes require `Authorization: Bearer mpr_<64hex>`.

| Method | Path                   | Auth          | Body                                            | Returns                                          |
|--------|------------------------|---------------|-------------------------------------------------|--------------------------------------------------|
| GET    | `/health`              | none          | —                                               | `{ ok, apns }`                                   |
| POST   | `/register`            | api key       | `{ token, bundleId? }`                          | `{ ok }`                                         |
| DELETE | `/register`            | api key       | `{ token }`                                     | `{ ok }`                                         |
| POST   | `/push`                | api key       | `{ token?, title?, body?, data? }`              | `{ sent, failed }` (broadcast if `token` omitted)|
| POST   | `/admin/api-keys`      | ADMIN_SECRET  | `{ name }`                                      | `{ id, name, key: "mpr_...", createdAt }` **once** |
| GET    | `/admin/api-keys`      | ADMIN_SECRET  | —                                               | `{ keys: [{ id, name, keyHash, createdAt }] }`  |
| DELETE | `/admin/api-keys/:id`  | ADMIN_SECRET  | —                                               | `{ ok }` (also removes that key's devices)       |

`/push` rate-limits per api key (default 60/min via `PUSH_RATE_MAX`). When APNs
returns `410 Unregistered` or `404 BadDeviceToken`, the relay deletes the stale
token automatically.

## First-time deploy

### 1. Get an APNs Auth Key from Apple

You need **one** `.p8` key (token-based APNs auth — not a per-environment cert):

1. Sign in at [developer.apple.com](https://developer.apple.com) →
   **Account → Certificates, Identifiers & Profiles → Keys**.
2. **+** create a key, name it (e.g. `Mobilecode Push`), enable
   **Apple Push Notifications service (APNs)**, continue, register.
3. **Download** `AuthKey_<KEYID>.p8` (you can only download it **once**).
4. Note the **Key ID** (10 chars, in the key's details) and your **Team ID**
   (10 chars, on the Membership page).

Put the file in `push-relay/config/AuthKey.p8`:

```sh
cp ~/Downloads/AuthKey_A8B9C0D1E2.p8 push-relay/config/AuthKey.p8
chmod 600 push-relay/config/AuthKey.p8
```

### 2. Configure env

```sh
cd push-relay
cp .env.example .env
chmod 600 .env
# Edit .env: set ADMIN_SECRET (openssl rand -hex 32), APNS_KEY_ID, APNS_TEAM_ID,
#            APNS_BUNDLE_ID. APNS_KEY_PATH defaults to /app/config/AuthKey.p8.
```

### 3. Run it

```sh
docker compose up -d --build
docker compose logs -f relay   # confirm "APNs ready" and "listening on ...:3000"
```

### 4. Create an api key

```sh
curl -X POST http://127.0.0.1:3000/admin/api-keys \
  -H "Authorization: Bearer $ADMIN_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"name":"opencodebar"}'
# => {"id":"...","name":"opencodebar","key":"mpr_<64hex>","createdAt":"..."}
```

Save that `mpr_...` value somewhere safe — it is shown **only once**. Point both
the iOS app's registration call and the OpenCodeBar watcher's `/push` call at
this relay with that key.

### 5. Expose it publicly with nginx + certbot

```sh
# 1. Point DNS: push.shathony.fr -> this server's IP.
# 2. Install the vhost + reload:
sudo cp nginx/push.shathony.fr.conf /etc/nginx/sites-available/
sudo ln -s /etc/nginx/sites-available/push.shathony.fr /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
# 3. Issue the cert (certbot rewrites the ssl block + adds the 80->443 redirect):
sudo certbot --nginx -d push.shathony.fr
```

The relay only listens on `127.0.0.1:3000`; nginx fronts it with TLS. After this,
the base URL for both clients is `https://push.shathony.fr`.

## Running without Docker

```sh
node --version    # >= 20
cp .env.example .env   # fill it in
npm install
npm start               # node src/server.js
```

## Security notes

- **The `.p8` key is your most sensitive file.** It is gitignored
  (`config/*.p8`), mounted read-only into the container, and never read into the
  database. Back it up somewhere safe (1Password, etc.) — if you lose it you
  must regenerate it and update `APNS_KEY_ID`. If it leaks, **revoke it** in the
  Apple Developer portal immediately and create a new one.
- **Rotate api keys.** Use the admin endpoints to issue a new key, repoint your
  clients, then delete the old one. Old tokens tied to a deleted key are pruned
  automatically.
- **`.env` is gitignored.** Never commit a real `.env`; never put real secrets
  in `docker-compose.yml`. Use `env_file: .env`.
- **Broadcasts are powerful.** `POST /push` with no `token` sends to **every**
  registered device for that api key. The per-key rate limit (`PUSH_RATE_MAX`)
  is the only guard — keep api keys scoped (one per caller).
- **No CORS secrets, no opencode creds.** This relay is intentionally dumb about
  your opencode setup. It cannot read your sessions, your passwords, or your
  Tailscale config.
- **HTTPS only.** The nginx vhost forces an 80→443 redirect and ships HSTS.
  Never expose port 3000 directly to the internet.

## License

Apache-2.0. See `../LICENSE` for the project-wide notice. Every file in this
directory carries an `SPDX-License-Identifier: Apache-2.0` header.
