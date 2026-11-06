# YouTube Remote

A **local** phone/web remote for YouTube playing in **Google Chrome on Windows**.

Your phone (or another device) opens a simple mobile UI served by a small Node.js server on the PC. A Chrome unpacked extension bridges precise player control (seek, volume, now playing, bass cut). Without the extension, basic Windows media keys and UI Automation still cover play/pause, next/previous, and coarse volume.

> This repository is a sanitized, reusable packaging of a working Windows setup. Defaults are **loopback-only** and generic. Enabling LAN listening is an explicit operator choice and should stay on a private/trusted network with an auth token.

## Features

- **Mobile UI** at `http://<host>:8790/` (port configurable)
- **Status pill** (tap): wake PC (small mouse nudge) + show/focus YouTube tab + refresh the remote page
- **Search** via `yt-dlp` (`ytsearch`); choosing a result loads the video in the existing YouTube tab and closes duplicate YouTube tabs when the extension bridge is connected
- **Playback**: play/pause, −10s / +10s seek, previous, next
- **Now playing** title/channel/thumbnail + seek bar (best with extension)
- **YouTube player volume** (− / slider / +) separate from **Windows system volume** (− / slider / +)
- **Bass cut** control (extension / Web Audio lowshelf; best-effort)
- Fallback **basic mode** when the extension is offline (tab title via UI Automation + media keys)

## Architecture

```
Phone browser  --HTTP/WS-->  Node server (server.js)  --WS-->  Chrome extension content script (YouTube tab)
                                 |  \
                                 |   \-- optional CDP helper (cdp.js) for a dedicated debug Chrome profile
                                 |
                                 \-- PowerShell helpers (focus tab, system volume, media keys)
```

- **`server.js`** serves `public/`, `/api/*`, and WebSockets (`role=ui` for the phone, `role=bridge` for the extension).
- **`extension/`** MV3 unpacked extension: content script connects to `ws://127.0.0.1:8790/?role=bridge` and executes player actions.
- **`scripts/*.ps1`** are fixed helpers invoked by the server (not arbitrary shell from the network).
- Search shells out to **`yt-dlp`** only with a constructed `ytsearchN:query` invocation (no free-form shell).

## Requirements

- Windows 10/11 PC with Google Chrome
- [Node.js](https://nodejs.org/) 18+ on the PC
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) on `PATH` (for search)
- Phone or tablet on the **same trusted LAN** if you enable LAN mode (or use only loopback / localhost tunneling you control)
- Permission to allow a Private-profile firewall rule if the phone cannot reach the PC

## Quick start

```bat
git clone https://github.com/multidimensionalinteractive/youtube-remote.git
cd youtube-remote
npm install
copy config.example.json config.local.json
npm start
```

By default the server listens on **`127.0.0.1:8790`** only. Open `http://127.0.0.1:8790/` on the PC to verify the UI.

### Load the Chrome extension (recommended)

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this repo’s `extension` folder
4. Open or refresh a [YouTube](https://www.youtube.com/) tab

The status pill should switch to **Bridge connected** when the content script attaches.

Host permissions are limited to YouTube origins plus `http(s)/ws` on `127.0.0.1:8790` and `localhost:8790`. If you change the server port, update both `extension/content.js` (`BRIDGE_URL`) and `extension/manifest.json` `host_permissions`, then reload the extension.

### Optional autostart

```bat
npm run install-startup
```

or

```bat
npm run install-autostart
```

These register a Startup-folder shortcut or a per-user scheduled task that runs `node server.js` from the install directory. They do **not** force-close Chrome.

## Configuration

Copy `config.example.json` → **`config.local.json`** (gitignored) and/or use `.env` (see `.env.example`).

| Setting | Env var | Default | Notes |
|---|---|---|---|
| `host` | `YT_REMOTE_HOST` | `127.0.0.1` | Use `0.0.0.0` only with LAN deliberately enabled |
| `port` | `YT_REMOTE_PORT` | `8790` | Keep extension permissions in sync if changed |
| `allowLan` | `YT_REMOTE_ALLOW_LAN` | `false` | When true / host is `0.0.0.0`, LAN bind is considered exposed |
| `authToken` | `YT_REMOTE_AUTH_TOKEN` | empty | **Required for non-loopback clients when LAN-exposed** |
| `allowedHosts` | `YT_REMOTE_ALLOWED_HOSTS` | `[]` | Extra allowed `Origin`/`Referer` hosts for CSRF checks |
| `chromePath` | `CHROME_PATH` | standard Chrome path | Used for open/CDP helpers |
| `chromeProfileDirectory` | `YT_REMOTE_CHROME_PROFILE_DIRECTORY` | `Default` | Chrome `--profile-directory` for native open fallback |
| `cdpPort` | `YT_REMOTE_CDP_PORT` | `9333` | Optional managed Chrome debugging port |
| `cdpProfileDir` | `YT_REMOTE_CHROME_PROFILE` | `./chrome-profile` | Isolated profile for optional CDP Chrome |

### Phone on Wi‑Fi (LAN) example

1. Set in `config.local.json`:

```json
{
  "host": "0.0.0.0",
  "port": 8790,
  "allowLan": true,
  "authToken": "replace-with-a-long-random-secret"
}
```

2. Open a Private-network firewall rule (elevated PowerShell):

```bat
npm run open-firewall
```

3. Ensure the Windows network profile is **Private** (Public Wi‑Fi profiles often block inbound LAN).
4. On the phone, open `http://<pc-lan-ip>:8790/` and paste the same token when prompted (or open `http://<pc-lan-ip>:8790/?token=...` once; the UI stores it in `localStorage`).

### Compatibility note for an existing deployment

If you already run a machine-specific install that binds `0.0.0.0:8790` without a token, this public package is stricter by default. To keep phone-on-LAN behavior, set `allowLan` + `authToken` (and firewall) as above. Core API shapes remain: `/api/health`, `/api/status`, `/api/search`, `/api/command`, `/api/system-volume`, plus UI/bridge websockets.

## Security

**Trust model:** this is a **local convenience remote**, not an internet service. Anyone who can reach the HTTP API on your LAN can attempt to control media, nudge the mouse (wake), change system volume, and see now-playing metadata.

### Do

- Keep the default **loopback bind** unless you need phone access
- Set a strong **`authToken`** whenever LAN listening is enabled
- Use the provided firewall script (**Private** profile only) — do **not** open the port on Public/Domain profiles casually
- Keep Chrome extension host permissions limited to YouTube + local server endpoints
- Treat `config.local.json`, `.env`, `chrome-profile/`, and any CDP profiles as **private** (gitignored)

### Do not

- **Port-forward / expose TCP 8790 (or your chosen port) to the public internet**
- Run this on hostile or guest networks without understanding the risk
- Commit tokens, cookies, browser profiles, logs, or personal paths
- Expect CSRF/token checks to replace a proper reverse-proxy auth stack — they are LAN hardening, not a public threat model

### Hardening included in this package

- Default listen address `127.0.0.1`
- Optional shared-secret token on APIs + UI websocket; LAN non-loopback clients require it
- CSRF-style `Origin`/`Referer` vs `Host` checks on mutating requests (with `allowedHosts` escape hatch)
- Action allowlist (no arbitrary command/shell endpoint)
- YouTube HTTPS URL validation before navigation helpers
- Bridge websocket accepted from loopback only
- Extension permissions scoped to YouTube + local app endpoints
- Fixed PowerShell scripts only (path-checked under `scripts/`)

## Troubleshooting

| Symptom | Things to try |
|---|---|
| Phone cannot connect | Confirm `allowLan`/host bind, Private firewall rule, PC firewall, same subnet/VLAN, Windows network = Private |
| Bridge offline | Load unpacked extension, refresh YouTube tab, confirm server on port `8790`, check `chrome://extensions` for errors |
| Search fails | Ensure `yt-dlp` is installed and on `PATH`; try `yt-dlp ytsearch1:test --flat-playlist --dump-json` |
| Seek / precise volume unavailable | Extension bridge required; basic mode only does media keys |
| Next does nothing without extension | Native fallback needs a focusable YouTube Chrome window |
| 401 Unauthorized | Enter the configured `authToken` in the UI auth box |
| CSRF 403 | Open the UI via the same host you configured; add host to `allowedHosts` if using a hostname/Tailscale name |
| Autostart didn’t run | Check Startup folder shortcut / Task Scheduler task `YouTubeRemoteServer` |

### Windows permissions / accessibility

UI Automation helpers need a normal interactive desktop session (not a headless service account). Focusing Chrome and selecting tabs may require the Chrome window to be accessible (not securely locked in a way that blocks UIA). First-time PowerShell may be fine with `-ExecutionPolicy Bypass` as used by the server for its own scripts.

## Optional CDP Chrome

`cdp.js` can attach to a Chrome instance with remote debugging on `cdpPort`, or launch an isolated `chrome-profile` with the extension preloaded. Prefer the normal unpacked-extension flow for your everyday profile. The helper **`scripts/launch-bridge-chrome.ps1`** starts an isolated profile and does **not** terminate existing Chrome processes.

## Development / verification assumptions

Syntax checks (`node --check`) are expected to pass on the published JS. End-to-end behavior (extension bridge, UIA focus, system volume, phone-on-LAN) depends on a Windows desktop with Chrome and was **not** re-field-tested against every generic hardware/network combination in this packaging pass. Treat LAN exposure carefully and verify on your own network before relying on it.

## License

MIT — see [LICENSE](./LICENSE).
