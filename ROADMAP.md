# Roadmap

Mobilecode-open — an open-source iOS companion app for [opencode](https://opencode.ai)
serve. Self-hosted, fully auditable. Apache-2.0; derivative of
`giuliastro/opencode-remote-android`.

## ✅ Shipped

- **Sessions** — list / detail / prompt / slash-commands / abort, concurrent across
  multiple project directories.
- **Full opencode surface** — permissions (Once/Always/Reject), fork, share/unshare,
  revert, summarize, shell, file read & search, providers & models picker, MCP/LSP/
  formatter diagnostics, config read.
- **Live updates** — adaptive polling (1 s busy / 5 s idle / 20 s background) backed by
  an SSE liveness stream; local notifications + haptic + sound on completion.
- **Two skins** — _Matrix_ (phosphor-hacker console, default, toggleable FX) and
  _OpenCode_ (clean warm-neutral + gold accent, no FX).
- **iOS integrations** — home-screen widget, Live Activity + Dynamic Island.
- **Shell console** — one-shot commands in a session's directory (`/session/:id/shell`).
- **Voice input** — on-device speech-to-text (`SFSpeechRecognizer`) in the composer.
- **Push notifications** — self-hosted APNs relay (`push-relay/`) + an OpenCodeBar
  watcher. **opencode credentials stay on your Mac**; the relay only holds the APNs key
  + device tokens. See [`docs/push.md`](docs/push.md).
- **OpenCodeBar** — macOS menu-bar controller for `opencode serve` (one-click ON/OFF,
  Keychain password, login item, auto-restart, push watcher).
- **CI / Release** — GitHub Actions (lint + tests + simulator build on push/PR; signed
  build → TestFlight on tag `v*` via fastlane).

## 🔜 Next

- **Security & robustness (M3)** — multi-server profiles, **Keychain** credentials,
  biometric (Face ID) unlock, self-signed certificate acceptance, http/https scheme
  selector.
- **CI / TestFlight** — wire the GitHub secrets (App Store Connect API key + `match`
  cert repo) so tagging `v*` ships to TestFlight. See [`docs/ci.md`](docs/ci.md).
- **App Intents / Shortcuts** (P1), **Share Extension** (P2).
- **True SSE streaming** (optional) — pending a fix for the `/event` proxy-buffering
  issue.

## Contributing

`npm run check` + `npm run test` must stay green. See `CLAUDE.md` (local dev handoff)
and `docs/testing.md`. Ported/new source files carry `// SPDX-License-Identifier:
Apache-2.0`. PRs welcome.
