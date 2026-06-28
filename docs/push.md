# Push notifications

Mobilecode-open can notify your phone when an opencode session finishes — **even when the
app is closed** — via a tiny self-hosted relay and the macOS menu-bar controller
(OpenCodeBar).

## How it works (and why it's safe)

The design keeps **opencode credentials on your Mac** and never sends them to the public
relay:

```
iPhone ──register(deviceToken, apiKey)──►  RELAY  (push.shathony.fr)   ──► APNs ──► 🔔
                                              holds: APNs key + device tokens
                                              NEVER sees opencode creds

Mac (OpenCodeBar) ── poll localhost:4096 ──►  WATCHER
   holds: opencode password (already has it)     detects busy → idle
   + relay apiKey (you configure it)             ▼
                                            POST relay /push {title, body}  (Bearer apiKey)
```

- The **relay** (`push-relay/`) is APNs-only. It stores the Apple Auth Key (`.p8`), device
  tokens, and API keys (hashed). Nothing else.
- The **watcher** (inside **OpenCodeBar**, on the Mac) polls your local opencode and asks the
  relay to push. Because OpenCodeBar already starts `opencode serve` with the password, the
  password never leaves your Mac.
- The **apiKey** is shared between the app (to register) and OpenCodeBar (to push). You create
  it on the relay and paste it into both. It is **user-entered**, never in source.

## Prerequisites (Apple — one time)

1. **App ID Push capability.** In the Apple Developer portal → Identifiers → your App ID
   (`ai.opencode.remote.ios`) → check **Push Notifications** → Save.
2. **APNs Auth Key.** Keys → generate a `.p8` key (note the **Key ID** + your **Team ID**).
   This single key serves APNs; you mount it on the relay.

## 1. Deploy the relay

On your bare-metal (e.g. the Proxmox host), in the `push-relay/` directory:

```bash
cd push-relay
cp .env.example .env
# edit .env: set ADMIN_SECRET (openssl rand -hex 32), APNS_KEY_ID, APNS_TEAM_ID,
#            APNS_BUNDLE_ID=ai.opencode.remote.ios, APNS_PRODUCTION=false (dev)
mkdir -p config && cp /path/to/AuthKey_<KEYID>.p8 config/AuthKey.p8   # your .p8
docker compose up -d --build
curl http://127.0.0.1:3000/health          # → {"ok":true}
```

Create an API key (the plaintext is shown **once**):

```bash
curl -X POST http://127.0.0.1:3000/admin/api-keys \
  -H "Authorization: Bearer $ADMIN_SECRET" -H "Content-Type: application/json" \
  -d '{"name":"mobilecode"}'        # → {"key":"mpr_…"}   ← copy this
```

The `.p8`, `.env`, and `data/` are gitignored — **no secrets are ever committed**.

## 2. Reverse proxy + DNS

Point **`push.shathony.fr`** at the host (you do the DNS on OVH), then on the reverse-proxy
box install the vhost and let certbot issue the cert:

```bash
sudo cp push-relay/nginx/push.shathony.fr.conf /etc/nginx/sites-available/
sudo ln -s /etc/nginx/sites-available/push.shathony.fr.conf /etc/nginx/sites-enabled/
sudo certbot --nginx -d push.shathony.fr        # issues the LE cert, sets up the 80→443 redirect
sudo systemctl reload nginx
curl https://push.shathony.fr/health            # → {"ok":true}  (from the internet)
```

The relay container binds `127.0.0.1:3000`; nginx fronts it with TLS + security headers
(`proxy_buffering off`).

## 3. Configure OpenCodeBar (the watcher)

On the Mac that runs `opencode serve`:

- Open the OpenCodeBar menu → **Set relay…** → enter `https://push.shathony.fr` + the `mpr_…`
  key from step 1.
- Check **Push notifications**.
- (Or via CLI: `OpenCodeBar.app/Contents/MacOS/OpenCodeBar --set-relay https://push.shathony.fr mpr_…`)

OpenCodeBar now polls `localhost:4096/session/status`; when a session goes busy → idle it
POSTs `{title, body}` to the relay, which pushes your phone.

## 4. Configure the app

In the app → **Settings → Push**:
- **Push relay URL:** `https://push.shathony.fr`
- **Push relay API key:** the same `mpr_…` key

On launch (iOS) the app requests permission, gets its APNs token, and `POST /register`s it
with the relay under that key. (The `aps-environment` entitlement + `UIBackgroundModes:
remote-notification` are wired in the project; you must have enabled the App ID Push capability
in step "Prerequisites".)

## End-to-end test

1. Start a session on opencode (busy). Close the app on the phone.
2. Let it finish → within ~8s OpenCodeBar fires the relay → you get a push.

## Troubleshooting

| Symptom | Check |
|---|---|
| No push | OpenCodeBar → Push notifications ON + relay configured; `OpenCodeBar --push-status` |
| Relay 503 on /push | APNs env not set (`APNS_KEY_PATH`/`KEY_ID`/`TEAM_ID`/`BUNDLE_ID`); `.p8` mounted |
| 401 on register/push | wrong apiKey; recreate via `/admin/api-keys` |
| Token never registered | app Settings relay URL+key set? iOS push permission granted? App ID Push capability ON + aps-environment in provisioning |
| 410 Gone on send | stale device token — the relay auto-prunes it; re-open the app to re-register |

## Switching aps-environment to production

For a TestFlight/App Store build, set `APNS_PRODUCTION=true` in the relay `.env` **and**
change `com.apple.developer.aps-environment` in `ios/App/App/OpenCodeRemote.entitlements`
from `development` to `production`, then rebuild.
