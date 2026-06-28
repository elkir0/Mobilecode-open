# CI & releases

Mobilecode-open ships two GitHub Actions workflows (in `.github/workflows/`).

## `ci.yml` — continuous integration

Runs on every push (to `main`/`master`) and every pull request. No Apple account
needed.

- **web** — `npm run check` (tsc + core tests) + `npm run test` (UI + core tests).
- **ios-simulator** — `npm run build:ios` then an unsigned simulator build
  (`CODE_SIGNING_ALLOWED=NO`). Catches iOS build regressions without signing.

## `release.yml` — TestFlight on tag `v*`

Pushing a tag matching `v*` (e.g. `v0.3.0`) builds a signed `.ipa` and uploads it
to TestFlight via fastlane (`bundle exec fastlane beta` from `ios/`).

It requires **five repository secrets** (Settings → Secrets and variables → Actions):

| Secret | What it is | How to get it |
|---|---|---|
| `ASC_API_KEY_KEY_ID` | App Store Connect API key ID | App Store Connect → Users and Access → Integrators → App Store Connect API → Generate |
| `ASC_API_KEY_ISSUER_ID` | Issuer ID (shown above the keys list) | same page |
| `ASC_API_KEY_P8_BASE64` | The `.p8` key, **base64-encoded** | `base64 -i AuthKey_XXXXXXXXXX.p8 \| pbcopy` |
| `MATCH_GIT_URL` | Private git repo holding signing certs | see `fastlane match` setup below |
| `MATCH_PASSWORD` | Password used to encrypt the match repo | your choice |

### First-time signing setup (`fastlane match`)

`match` stores your signing certificate + provisioning profile in an encrypted
private git repo, so CI can sign reproducibly.

```bash
cd ios
bundle install
# one-time: generate certs into a NEW private repo (e.g. github.com/elkir0/mobilecode-cert)
bundle exec fastlane match appstore \
  --git-url "git@github.com:elkir0/mobilecode-cert.git" \
  --app_identifier "ai.opencode.remote.ios"
```

Set `MATCH_GIT_URL` + `MATCH_PASSWORD` as repo secrets, then tag a release:

```bash
git tag v0.3.0 && git push origin v0.3.0   # triggers release.yml → TestFlight
```

> **Tip** — use a dedicated App Store Connect API key with the *App Manager* role
> and **App Manager / Developer** scope; it needs “Upload” access for TestFlight.
