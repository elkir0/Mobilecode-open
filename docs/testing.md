# M1 Integration Test Checklist

Run against a real `opencode serve` exposed via Tailscale Serve.

## Preconditions
- `opencode serve` running on the dev machine: `opencode serve --hostname 0.0.0.0 --port 4096` with `OPENCODE_SERVER_PASSWORD` set.
- Exposed via Tailscale Serve: `tailscale serve --https 443 http://localhost:4096` → reachable at `https://<machine>.<tailnet>.ts.net`.
- iPhone on the same tailnet (Tailscale app installed & logged in).
- App installed via Xcode on a physical device (the native SSE plugin + local notifications need a real device for full behavior; the simulator verifies compile + UI).

## Automated gate (run before tagging)
```bash
cd web && npm run check
```
Must be green (tsc -b + 13 core tests).

## Simulator build gate (run before tagging)
```bash
xcodebuild -project ios/App/App.xcodeproj -scheme App -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -configuration Debug build CODE_SIGNING_ALLOWED=NO
```
Must end with `** BUILD SUCCEEDED **`.

## Manual device checks (on a real iPhone over Tailscale)
- [ ] Enter server URL `https://<machine>.<tailnet>.ts.net`, port `443`, username `opencode`, password.
- [ ] Tap Test → "Connected to opencode vX.Y.Z" (no cert warning — Tailscale Serve = valid Let's Encrypt).
- [ ] Save → Sessions list appears; connection badge shows **connected** (not "reconnecting").
- [ ] Open a session → messages, todos, diff load.
- [ ] Send a prompt → optimistic bubble appears; reply streams in live (no manual refresh).
- [ ] Trigger work on the desktop TUI in parallel → iPhone session list updates within ~1s without polling.
- [ ] Background the app, return → reconnects within ~1-2s; badge returns to connected.
- [ ] Complete a session while viewing another → local notification fires + haptic.
- [ ] Tap the notification → opens the completed session detail.
- [ ] Run a `/command` (e.g. `/init`) → executes and result appears.

## Dev path (no Tailscale, no device)
- `npm run mock` in one terminal, then in the app (simulator) connect to host `127.0.0.1` port `4096` over HTTP.
- NOTE: the native SSE plugin only activates on-device/simulator via the Capacitor bridge. In-browser `npm run dev` uses the in-memory fallback (no live stream) — that is expected.

## Honest scope reminder
The "continuous link" is guaranteed while the app is active or recently foregrounded. It is NOT server push. This is documented; the future commercial push relay (M2+) closes the gap.
