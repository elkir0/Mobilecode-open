# OpenCodeBar — macOS menu-bar controller for `opencode serve`

A tiny native macOS menu-bar app (AppKit `NSStatusItem`, no Dock icon) that starts/stops
the `opencode serve` instance the OpenCode Remote iOS app talks to — so you never have to
open a terminal and type the command again.

One-click **ON/OFF**, live status, copy the Tailscale connection URL, start at login,
password stored in the Keychain, auto-restart on crash.

> Tailscale Serve (`tailscale serve --bg --https 443 http://localhost:4096`) is already
> persistent on this Mac, so OpenCodeBar only manages the `opencode serve` process — the
> `https://<machine>.ts.net` URL stays the same across stop/start.

## Build

```bash
bash menubar/build.sh        # → menubar/OpenCodeBar.app (compiled + ad-hoc signed)
```

Requires Xcode's swiftc (present with Xcode 26). Targets macOS 13+ (SMAppService / SF Symbols).

## Install (so it survives reboots)

```bash
mv menubar/OpenCodeBar.app /Applications/
open /Applications/OpenCodeBar.app          # launches it (menu-bar dot appears)
```

Then click the menu-bar dot → **Start at Login** (adds it to Login Items via `SMAppService`).

## Usage (menu bar)

| Item | Action |
|---|---|
| ● / ○ status dot | green = `opencode serve` running, gray = stopped |
| **Start / Stop** | toggle the server (spawns `opencode serve --hostname 0.0.0.0 --port 4096 --cors …` with `OPENCODE_SERVER_PASSWORD` from the Keychain) |
| **Copy connection URL** | copies `https://<machine>.ts.net` (parsed from `tailscale serve status`) — paste it into the iOS app |
| **Start at Login** | checkbox — launch OpenCodeBar at login |
| **Auto-restart on crash** | checkbox — relaunch `opencode serve` if it dies unexpectedly |
| **Quit** | quit OpenCodeBar |

First **Start** prompts once for the server password (stored in the macOS Keychain,
`OPENCODE_SERVER_PASSWORD`). Re-set it any time via the CLI (below).

## CLI mode (scripting / testing)

The same binary works from the terminal — useful for scripts or the iOS app's setup:

```bash
APP="OpenCodeBar.app/Contents/MacOS/OpenCodeBar"
$APP --status                       # prints "running" / "stopped" (exit 0/1)
$APP --url                          # prints the https://*.ts.net URL
$APP --start                        # start opencode serve
$APP --stop                         # stop opencode serve
$APP --set-password "<your-password>"   # store the password in the Keychain
$APP --help
```

## How it works

- Spawns `opencode serve` as a child `Process` with the CORS origins the iOS webview needs
  (`capacitor://localhost`, `https://localhost`) and the password from the Keychain.
- Detects an already-running `opencode serve` (ours or external) via `pgrep -f "opencode serve"`
  and reflects it as "Running".
- Reads the connection URL from `tailscale serve status`.
- On unexpected termination + "Auto-restart" on, relaunches after a 2 s backoff.
- `LSUIElement = true` → menu-bar only, no Dock icon.

## Files
- `main.swift` — the app (GUI + CLI entry points, `ServerController`, Keychain, shell helpers).
- `Info.plist` — bundle config (`LSUIElement`, min macOS 13).
- `build.sh` — `swiftc` compile → `.app` bundle → ad-hoc codesign.

Apache-2.0 (derivative of the OpenCode Remote project).
