# YouTube Remote

A **local** phone/web remote for YouTube playing in **Google Chrome on Windows**. Works on **iPhone and Android** (and any other browser on your network) and can be added to the home screen like an app.

Your iPhone or Android phone (or another device) opens a simple mobile UI served by a small Node.js server on the PC. A Chrome unpacked extension bridges precise player control (seek, volume, now playing, bass cut). Without the extension, basic Windows media keys and UI Automation still cover play/pause, next/previous, and coarse volume.

> This repository is a sanitized, reusable packaging of a working Windows setup. Defaults are **loopback-only** and generic. Enabling LAN listening is an explicit operator choice and should stay on a private/trusted network with an auth token.

## Easy install (Windows)

No terminal needed. Your phone does not need to download anything.

1. **Download** [youtube-remote.zip](https://github.com/multidimensionalinteractive/youtube-remote/releases/latest/download/youtube-remote.zip) (or on this page click **Code > Download ZIP**).
2. **Extract it**: right-click the ZIP, choose **Extract All...**, and open the extracted folder. Running it from inside the ZIP will not work.
3. **Double-click `install.cmd`.** If Windows shows "Windows protected your PC", click **More info > Run anyway** (the files are plain scripts you can read in this repo).
4. Follow the window. It explains each step before doing it:
   - checks for Node.js 18+ and yt-dlp, and offers to install them with `winget`
   - runs `npm install`
   - turns on phone access with a random private access token (an existing token is never replaced)
   - adds a Windows firewall rule for **Private (home) networks only**; this is the only step that asks for admin
   - starts the remote automatically when you sign in (Startup folder shortcut)
   - starts the remote now in the background (restarting an older copy if one is running; it never closes Chrome)
   - opens Chrome's Extensions page and walks you through **Load unpacked** for the `extension` folder. Chrome does not let any program install an extension silently (that protects you from malware), so this one part is a few clicks by you.
   - opens the **Connect your phone** page with a QR code
5. **Scan the QR code** with your phone camera. Then add it to your home screen: iPhone (Safari) **Share > Add to Home Screen**; Android (Chrome) **⋮ > Add to Home screen**.

Running `install.cmd` again is safe: it keeps your settings and token and repairs anything missing. To remove it, double-click **`uninstall.cmd`**: it stops the remote, removes autostart and the firewall rule, and tells you how to remove the extension. Your folder and settings are left for you to delete.

The installer never prints your access token. The only place it shows the full phone link is the **Connect your phone** page on `http://127.0.0.1:8790/`, which the server only serves to this PC's own browser.

## Features

- **One-click Windows installer** (`install.cmd`) and uninstaller (`uninstall.cmd`) that explain every step
- **Phone link + QR code** printed on startup and shown on the PC's own page, so connecting a phone is a scan
- **Mobile UI** at `http://<host>:8790/` (port configurable) for iPhone and Android
- **Home screen app**: web app manifest, Android and iOS icons (including maskable), standalone full-screen mode, safe-area aware layout
- **Status pill** (tap): wake PC (small mouse nudge) + show/focus YouTube tab + refresh the remote page
- **Tab picker**: with several YouTube tabs or windows open, a **tabs** button next to the status pill lists them all (title, thumbnail, playing or paused, which window). Tap one to control it; your pick is remembered and other tabs can no longer take over the remote
- **Search** via `yt-dlp` (`ytsearch`); choosing a result loads the video in the YouTube tab you are controlling
- **Playback**: play/pause, −10s / +10s seek, previous, next
- **Now playing** title/channel/thumbnail + seek bar (best with extension)
- **YouTube loudness** (− / slider / +) via persistent Web Audio **GainNode** when the bridge is attached (separate from **Windows system volume**); remote UI ignores status volume while you are dragging the slider
- **Bass cut** slider (− / +) via lowshelf filter (neutral default; independent of GainNode loudness / system volume)
- **Screens off** button: turns the PC monitors off while the video keeps playing (no sleep, no lock); tap the status pill to wake them
- **Queue ("Up next")**: see what plays next and edit it from your phone. Add search results with **Play next** or **Add to queue**, drag or use Up / Down to reorder, remove items, tap one to play it now, or clear the queue. Also shows YouTube's own next videos (the rest of a playlist or mix, or the autoplay pick) and lets you jump to any of them
- **Stop after this video** toggle: when On (green), playback pauses at the end of the current video instead of autoplaying the next one; when Off, YouTube keeps playing as normal
- Fallback **basic mode** when the extension is offline (tab title via UI Automation + media keys)
- **LAN hardening**: loopback default bind, optional shared `authToken`, CSRF Origin/Host checks, Private-profile firewall helper, minimal unauthenticated `/api/health`

## Architecture

```
Phone browser  --HTTP/WS-->  Node server (server.js)  --WS-->  Chrome extension content script (YouTube tab)
                                 |  \
                                 |   \-- optional CDP helper (cdp.js) for a dedicated debug Chrome profile
                                 |
                                 \-- PowerShell helpers (focus tab, system volume, media keys)
```

- **`server.js`** serves `public/`, `/api/*`, and WebSockets (`role=ui` for the phone, `role=bridge` for the extension).
- **`extension/`** MV3 unpacked extension: every YouTube tab's content script connects to `ws://127.0.0.1:8790/?role=bridge&tab=<its tab id>` and executes player actions.
- **`lib/tabs.js`** keeps the list of connected YouTube tabs and decides which one the remote controls.
- **`scripts/*.ps1`** are fixed helpers invoked by the server (not arbitrary shell from the network).
- Search shells out to **`yt-dlp`** only with a constructed `ytsearchN:query` invocation (no free-form shell).

## Bass cut (extension)

The bridge content script inserts a **Web Audio** graph on the managed YouTube `<video>` element:

`HTMLMediaElement` → `MediaElementAudioSourceNode` → **lowshelf** `BiquadFilterNode` → **`GainNode`** → `AudioContext.destination`

| Control | Behavior |
|---|---|
| Slider amount `0` | Neutral: filter gain **0 dB** (default) |
| Slider amount `1` | Maximum cut: **−30 dB** lowshelf (configurable in `extension/content.js` → `BASS_CONFIG.maxCutDb`) |
| Corner frequency | **200 Hz** by default (intended band ~150–250 Hz) |
| − / + buttons | Step amount by `0.05` (`bassBy`) |

**What it is for:** taming excessive low end on **headphones**, laptop speakers, or a desktop near-field setup without turning down the whole mix. It is a *cut* control, not a loudness / YouTube volume replacement.

**What it does not do:** it is not a replacement for YouTube or Windows volume. Seek, now-playing, and Premium playback continue through the normal player. Status reports `bass`, `bassDb`, `bassHz`, and `bassMaxDb` alongside `volume` so the phone UI stays in sync.

**Volume architecture (verified):** Filtering polluted element/player reads with `lastKnownVolume` alone is **not sufficient**. A newly inserted YouTube `<video>` can still play at real **100%** on the default audio route before the bass graph re-wraps, while the remote UI showed a lower cached value and Windows system volume stayed unchanged. The decisive fix adds a persistent **`GainNode`** as the loudness authority:

- Chain: source → lowshelf → **gain** → destination
- Remote volume slider / `setVolume` write **`GainNode.gain`** (status reports that real value, plus `gain` / `bassAttached`)
- New `<video>` elements are **clamped immediately** toward the desired loudness to shrink the pre-wrap blast window
- Wrap runs on **`play` (capture)**, a **`MutationObserver`**, and a **500ms** backup interval
- After wrap, element `.volume` is left at `1` so loudness is not double-attenuated; bass cut remains independent lowshelf gain (e.g. amount `0.75` → **−22.5 dB**)
- Mobile UI still ignores status volume updates during pointer/touch and suppresses programmatic slider feedback

**Resilience (verified approach):**

- Sources are remembered in a `WeakMap` so `createMediaElementSource` is only called once per element; when YouTube replaces the `<video>`, the source reconnects to the shared filter/gain
- `AudioContext.resume()` runs on media play gestures and when the tab becomes visible again (Chrome autoplay / suspended context)
- Bass amount persists for the tab via `sessionStorage`
- On `pagehide`, the context is suspended (not torn down) to avoid breaking ongoing playback plumbing

Tune `BASS_CONFIG` in `extension/content.js` (mirror defaults live in `lib/bass.js` for tests). No remote CDN or extra extension permissions are required for bass. The extension uses only the YouTube + local bridge host permissions, `tabs` to know each YouTube tab's id and window and to bring a tab to the front, and `storage` to remember the Stop after this video setting.

Reload the unpacked extension after changing `BASS_CONFIG` or `content.js`.

## Screens off

Tap **Screens off** to turn the monitors off while audio and video keep playing. Handy for music, podcasts, or falling asleep to a video without a bright screen.

- The server runs the fixed helper `scripts/screens-off.ps1` with `powershell -File` (allowlisted action `screensOff`). It must run in your normal logged-in desktop session, which is the case for `npm start`, the Startup-folder shortcut, and the per-user scheduled task.
- The script sends the Windows `SC_MONITORPOWER` "off" message (via both `PostMessage` and `SendMessage`) to the broadcast window and the taskbar, then repeats it for about 4 seconds, because a playing video often asks Windows to turn the display back on right away.
- It does **not** sleep, hibernate, or lock the PC, and it writes no log files.
- To turn the screens back on, tap the **status pill** (which runs `wakePC`, a tiny mouse nudge), or move the mouse / press a key at the PC. Background status polling never wakes the screens.
- Some monitors or GPU drivers ignore `SC_MONITORPOWER` or wake on any input event. If the screens come back on by themselves, check for a device (mouse, controller, webcam app) that is sending input.

## Queue (Up next)

The **Up next** card shows what will play after the current video, and lets you change it.

**Your queue** (editable):

- In search results, tap **Play next** to put a video at the front of the queue, or **Add to queue** to put it at the end. Tapping the result itself still plays it right away.
- Reorder by dragging the **≡** handle (works with touch on iPhone Safari and Android Chrome, and with a mouse), or with the **Up** / **Down** buttons.
- **Remove** takes a video out. **Clear queue** empties it (it asks first).
- Tap a video's title to play it now (it leaves the queue).
- When the current video ends, the next video in your queue starts automatically, before YouTube's own autoplay or playlist. **Next** also plays the front of your queue first. Ads are skipped over: the queue only advances at the end of the real video.
- **Stop after this video** wins: when it is On, playback stops at the end and the queue waits. Turn it Off (or tap Next) to continue.
- The queue lives in the YouTube tab's own storage on the PC (`localStorage` for youtube.com), so it survives page reloads and shows the same on every phone. It holds up to 200 videos.

**YouTube's own next videos** (read-only):

- Below your queue, the card lists what YouTube itself will play next: the rest of the current **playlist or mix**, or the single **autoplay** "Up next" video. Tap one to jump to it.
- These come from YouTube's page, so they cannot be reordered from the remote. To change the order, add videos to your queue instead; your queue always plays first.

Queue actions need the Chrome extension bridge. After updating, reload the unpacked extension on `chrome://extensions` and refresh the YouTube tab (the extension now also loads `queue-core.js`).

## Multiple YouTube tabs

If you have more than one YouTube tab or window open, every one of them connects to the server, and the remote controls one at a time.

- Tap the **tabs** button next to the status pill (for example **3 tabs**). The list shows each tab's video, whether it is playing or paused, and which window it is in when you have more than one.
- **Tap a tab** to control it. From then on everything on the remote goes to that tab only: play/pause, seek, Next, search results, Now Playing, the queue, Stop after this video, YouTube volume and bass. Other tabs keep playing or sitting paused, untouched.
- **Show on PC** does the same and also brings that tab to the front on the PC.
- Your pick is saved on the PC (`.selected-tab.json` next to `server.js`), so it survives a server restart. Status updates from other tabs never change it.
- **Auto** (the default, or tap **Switch to Auto**) follows whatever is playing: it stays on the current tab while it plays and only moves when that tab is paused and another tab is playing.
- If the tab you picked is closed, the remote switches to a playing tab (or else the one you used most recently) and shows a yellow note saying which tab it is controlling now. A tab that is only reloading or moving to the next video keeps its place.
- Only the tab you control runs your queue and Stop after this video. Your queue is shared by all YouTube tabs (it lives in youtube.com's storage), but it only advances in the controlled tab.
- Playing something no longer closes your other YouTube tabs. To close them on purpose, send the `cleanupYouTube` action.

Older builds of the extension connected one tab at a time and each new tab kicked the previous one off, which made the remote jump between tabs. After updating, reload the unpacked extension on `chrome://extensions` (it also refreshes your YouTube tabs).

## Stop after this video

Tap **Stop after this video** to switch it between **Off** and **On**. The button turns green while it is On.

- **On:** about 1 second before the current video ends, the extension pauses it, cancels the autoplay / "Up next" countdown, and turns the player's autoplay toggle off, so YouTube does not move on to the next video or the next playlist item. Ads are ignored, so it only stops at the end of the real video.
- **Off:** YouTube behaves normally and keeps playing whatever comes next.
- The setting stays On until you turn it Off. It is saved in the extension's `chrome.storage.local` (survives tab reloads and browser restarts) and mirrored in the tab's `sessionStorage` so it applies instantly as YouTube swaps pages.
- Status responses include `stopAfter: true|false`, so every phone showing the remote stays in sync.
- Requires the Chrome extension bridge (actions `toggleStopAfter` and `setStopAfter` with `{ "enabled": true|false }`). It uses the `storage` extension permission; reload the unpacked extension after updating.

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

## Connect your phone in 3 steps

The phone only needs its web browser. It does **not** need the ZIP or any app. Everything runs on the PC, and the phone just opens a web page that the PC serves on your home Wi-Fi.

1. On the PC, in this folder, run:

   ```bat
   npm run setup-phone
   ```

   This creates or updates `config.local.json` with `host` `0.0.0.0`, `allowLan` `true`, and a random `authToken` (an existing token is never replaced, and the token is not printed).
2. In an **admin** terminal in this folder, run `npm run open-firewall` (Private networks only). Then run `npm start` (restart it if it was running).
3. The server prints a **phone link** and a **QR code**. Scan it with the phone camera (phone on the same Wi-Fi), then add it to the home screen. The same link and QR code are on `http://127.0.0.1:8790/` on the PC, in the **Connect your phone** panel.

The phone link looks like `http://<pc-lan-ip>:8790/?token=...`. It contains your access token, so do not post or share it publicly. The phone saves the token on first open and removes it from the address bar.

When phone access is off, the server prints a one-line hint pointing back to these steps. It lists only private home network addresses (Wi-Fi first, then Ethernet) and skips loopback, `169.254.x.x`, WSL / Hyper-V `vEthernet`, Docker, VPN, and other virtual adapters.

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

`npm run setup-phone` does step 1 for you. To do it by hand:

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

### Add it to your phone's home screen

**iPhone (Safari):** open the remote, tap **Share**, then **Add to Home Screen**.

**Android (Chrome):** open the remote, tap the **⋮** menu, then **Add to Home screen** (on some versions: **Install app**), then **Add**. The icon opens the remote full screen without the browser bar. Samsung Internet and Firefox for Android have the same option in their menus.

Good to know on Android:

- Over plain `http://<pc-lan-ip>:8790/`, Chrome treats the page as "not secure", so it will not show its automatic install banner. **Add to Home screen** from the menu still works and creates a shortcut that opens the remote in its own window with the app icon. On newer Chrome versions the shortcut may open inside a Chrome tab instead of full screen; that is normal for HTTP pages and every control still works.
- For a full installed app (install banner, app drawer entry, true standalone window), the page must be served over **HTTPS** (or from `localhost`). One easy option is Tailscale, below.
- The access token you paste once is saved in the browser for that address, so the home screen icon opens straight into the remote. If you later use a different address (for example the HTTPS one), paste the token once there too.
- Sliders, buttons, and search are touch-first: no hover-only controls, no double-tap zoom delay, and slider drags that Android cancels are handled cleanly.

### Optional: HTTPS with Tailscale (full Android install)

If you use [Tailscale](https://tailscale.com/) on the PC and the phone, Tailscale can put a trusted HTTPS address in front of the remote without opening any ports:

1. In the Tailscale admin console, turn on **MagicDNS** and **HTTPS certificates**.
2. Set a strong `authToken` in `config.local.json` first. Requests relayed by `tailscale serve` arrive from the PC itself, and this server detects that and requires the token for them anyway; without a token they are refused.
3. On the PC, run:

```bat
tailscale serve --bg 8790
```

4. On the phone (with Tailscale connected), open the `https://<your-pc-name>.<your-tailnet>.ts.net/` address that `tailscale serve status` prints, paste the token, then use Chrome's **Install app** prompt or **⋮ > Install app**.
5. If you see a CSRF 403, add that `.ts.net` host to `allowedHosts`.

The server can stay on its default loopback-only bind with this setup, because Tailscale connects to it locally. Only devices signed in to your tailnet can reach the address. Use `tailscale serve` (private to your tailnet), **not** `tailscale funnel` (public internet). Run `tailscale serve --https=443 off` to turn it off again.

### Compatibility note for an existing deployment

If you already run a machine-specific install that binds `0.0.0.0:8790` without a token, this public package is stricter by default. To keep phone-on-LAN behavior, set `allowLan` + `authToken` (and firewall) as above. Core API shapes remain: `/api/health`, `/api/status`, `/api/search`, `/api/command`, `/api/system-volume`, plus UI/bridge websockets.

## Security

**Trust model:** this is a **local convenience remote**, not an internet service. Anyone who can reach the HTTP API on your LAN can attempt to control media, nudge the mouse (wake), turn the monitors off, change system volume, and see now-playing metadata.

### Do

- Keep the default **loopback bind** unless you need phone access
- Set a strong **`authToken`** whenever LAN listening is enabled
- Use the provided firewall script (**Private** profile only); do **not** open the port on Public/Domain profiles casually
- Keep Chrome extension host permissions limited to YouTube + local server endpoints
- Treat `config.local.json`, `.env`, `chrome-profile/`, and any CDP profiles as **private** (gitignored)

### Do not

- **Port-forward / expose TCP 8790 (or your chosen port) to the public internet**
- Run this on hostile or guest networks without understanding the risk
- Commit tokens, cookies, browser profiles, logs, or personal paths
- Expect CSRF/token checks to replace a proper reverse-proxy auth stack; they are LAN hardening, not a public threat model

### Hardening included in this package

- Default listen address `127.0.0.1`
- Optional shared-secret token on APIs + UI websocket; LAN non-loopback clients require it
- CSRF-style `Origin`/`Referer` vs `Host` checks on mutating requests (with `allowedHosts` escape hatch)
- Action allowlist (no arbitrary command/shell endpoint)
- YouTube HTTPS URL validation before navigation helpers
- Bridge websocket accepted from loopback only
- Requests relayed by a local reverse proxy (for example `tailscale serve`) do not get loopback trust; they need the token and cannot act as the bridge
- Extension permissions scoped to YouTube + local app endpoints (`tabs` and `storage` only + host allowlist)
- Fixed PowerShell scripts only (path-checked under `scripts/`)
- Baseline security headers (`X-Content-Type-Options`, `X-Frame-Options`, CSP); no `Access-Control-Allow-Origin: *`
- Unauthenticated `/api/health` omits now-playing `lastStatus` (loopback or token required for that detail)
- The **Connect your phone** data (`/api/phone-link`, which includes the token) is only served to a direct loopback request with a `127.0.0.1` / `localhost` Host header and no cross-site fetch; everyone else gets a 404 (this also blocks DNS rebinding)
- The installer and uninstaller only stop this app's own `node server.js` process (by PID file or port), never Chrome

## Troubleshooting

| Symptom | Things to try |
|---|---|
| Server never shows a phone address | Phone access is off: run `npm run setup-phone` (or `install.cmd`) and restart. If it says no address was found, connect the PC to Wi-Fi or Ethernet |
| Phone link times out | Phone must be on the same Wi-Fi (not guest Wi-Fi or mobile data); run `npm run open-firewall` as admin; set the Windows network to Private |
| `install.cmd` closes right away or says "opened from inside the ZIP" | Extract the ZIP first (right-click > Extract All...), then run `install.cmd` from the extracted folder |
| Phone cannot connect | Confirm `allowLan`/host bind, Private firewall rule, PC firewall, same subnet/VLAN, Windows network = Private |
| Bridge offline | Load unpacked extension, refresh YouTube tab, confirm server on port `8790`, check `chrome://extensions` for errors |
| Search fails | Ensure `yt-dlp` is installed and on `PATH`; try `yt-dlp ytsearch1:test --flat-playlist --dump-json` |
| Seek / precise volume unavailable | Extension bridge required; basic mode only does media keys |
| Next does nothing without extension | Native fallback needs a focusable YouTube Chrome window |
| 401 Unauthorized | Enter the configured `authToken` in the UI auth box |
| CSRF 403 | Open the UI via the same host you configured; add host to `allowedHosts` if using a hostname/Tailscale name |
| Screens off does nothing | Make sure the server runs in your logged-in desktop session (not as a service or another user); some monitors ignore the power-off message |
| Screens turn back on right away | Something is sending input (mouse, controller, an app); tap Screens off again after it settles |
| Stop after this video does not stop | Reload the unpacked extension (it needs the `storage` permission) and refresh the YouTube tab; the bridge must be connected |
| Android: no "Install app" option | Expected over plain HTTP. Use **⋮ > Add to Home screen**, or use the Tailscale HTTPS setup for a full install |
| Android: home screen icon asks for the token again | The token is saved per address; paste it once at the address the icon opens |
| Queue does not appear or says the bridge is offline | Reload the unpacked extension on `chrome://extensions`, then refresh the YouTube tab |
| Queue did not advance at the end | Check that **Stop after this video** is Off; the queue also waits while an ad plays |
| YouTube's next videos list is empty | It only shows on a watch page with a playlist, mix, or autoplay suggestion; YouTube sometimes changes its page layout, and your own queue keeps working either way |
| Remote keeps switching between YouTube tabs | Update and reload the unpacked extension, then pick a tab from the **tabs** button; older extension builds made tabs take turns |
| Tabs button does not show | It appears once a YouTube tab with the updated extension is connected; reload the extension and refresh your YouTube tabs |
| Remote controls the wrong tab after closing one | It fell back to a playing or recent tab (see the yellow note); open the tabs list and tap the one you want |
| Autostart didn’t run | Check Startup folder shortcut / Task Scheduler task `YouTubeRemoteServer` |

### Windows permissions / accessibility

UI Automation helpers need a normal interactive desktop session (not a headless service account). Focusing Chrome and selecting tabs may require the Chrome window to be accessible (not securely locked in a way that blocks UIA). First-time PowerShell may be fine with `-ExecutionPolicy Bypass` as used by the server for its own scripts.

## Optional CDP Chrome

`cdp.js` can attach to a Chrome instance with remote debugging on `cdpPort`, or launch an isolated `chrome-profile` with the extension preloaded. Prefer the normal unpacked-extension flow for your everyday profile. The helper **`scripts/launch-bridge-chrome.ps1`** starts an isolated profile and does **not** terminate existing Chrome processes.

## Development / verification assumptions

```bat
npm test
node --check server.js
```

`npm test` covers bass math (including the live-verified `0.4 → −12 dB` mapping), persistent GainNode loudness / media-swap volume behavior, content-script wiring assertions, and UI control presence (including Screens off and Stop after this video wiring), **without** launching Chrome or touching a real browser profile.

End-to-end playback (extension bridge on a signed-in YouTube/Premium tab, UIA focus, system volume, phone-on-LAN) depends on a Windows desktop with Chrome. This packaging pass does **not** attach to or modify an operator’s everyday Chrome profile. Treat LAN exposure carefully and verify on your own network before relying on it.

## License

MIT. See [LICENSE](./LICENSE).
