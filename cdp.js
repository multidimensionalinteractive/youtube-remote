'use strict';

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { loadConfig } = require('./lib/config');

const config = loadConfig();
const CDP_PORT = config.cdpPort;
const CHROME_PATH = config.chromePath;
const PROFILE_DIR = config.cdpProfileDir;
const EXT_DIR = path.join(config.root, 'extension');

let cdpBrowserWs = null;
let cdpPageWs = null;
let cdpPageId = null;
let cdpReqId = 1;
const cdpPending = new Map();

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    }).on('error', reject);
  });
}

function cdpSend(ws, method, params = {}, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error('CDP socket not connected'));
      return;
    }
    const id = cdpReqId++;
    const timer = setTimeout(() => {
      cdpPending.delete(id);
      reject(new Error('CDP timeout: ' + method));
    }, timeoutMs);
    cdpPending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function attachSocketHandlers(ws) {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg.id != null && cdpPending.has(msg.id)) {
      const p = cdpPending.get(msg.id);
      cdpPending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    }
  });
}

async function ensureChrome() {
  try {
    const ver = await httpGet('http://127.0.0.1:' + CDP_PORT + '/json/version');
    if (ver.status === 200) return JSON.parse(ver.body);
  } catch (_) {}

  await new Promise((resolve, reject) => {
    const argLine = [
      '--remote-debugging-port=' + CDP_PORT,
      '--remote-allow-origins=*',
      '--user-data-dir="' + PROFILE_DIR + '"',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-popup-blocking',
      '--autoplay-policy=no-user-gesture-required',
      '--load-extension="' + EXT_DIR + '"',
      '--disable-extensions-except="' + EXT_DIR + '"',
      'https://www.youtube.com/',
    ].join(' ');
    const child = spawn('"' + CHROME_PATH + '"', [argLine], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      shell: true,
    });
    child.on('error', reject);
    child.unref();
    setTimeout(resolve, 3000);
  });

  for (let i = 0; i < 20; i++) {
    try {
      const ver = await httpGet('http://127.0.0.1:' + CDP_PORT + '/json/version');
      if (ver.status === 200) return JSON.parse(ver.body);
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Chrome CDP did not come up on port ' + CDP_PORT);
}

async function listPages() {
  const res = await httpGet('http://127.0.0.1:' + CDP_PORT + '/json/list');
  return JSON.parse(res.body).filter((t) => t.type === 'page');
}

async function connectPage(target) {
  if (cdpPageWs) {
    try { cdpPageWs.close(); } catch (_) {}
    cdpPageWs = null;
  }
  cdpPageId = target.id;
  cdpPageWs = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    cdpPageWs.once('open', resolve);
    cdpPageWs.once('error', reject);
  });
  attachSocketHandlers(cdpPageWs);
  await cdpSend(cdpPageWs, 'Runtime.enable');
  await cdpSend(cdpPageWs, 'Page.enable');
}

async function ensureYouTubePage(url) {
  await ensureChrome();
  let pages = await listPages();
  let yt = pages.find((p) => /youtube\.com/i.test(p.url || '')) || pages[0];
  if (!yt) {
    const ver = JSON.parse((await httpGet('http://127.0.0.1:' + CDP_PORT + '/json/version')).body);
    if (!cdpBrowserWs || cdpBrowserWs.readyState !== WebSocket.OPEN) {
      cdpBrowserWs = new WebSocket(ver.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        cdpBrowserWs.once('open', resolve);
        cdpBrowserWs.once('error', reject);
      });
      attachSocketHandlers(cdpBrowserWs);
    }
    const created = await cdpSend(cdpBrowserWs, 'Target.createTarget', { url: url || 'https://www.youtube.com/' });
    pages = await listPages();
    yt = pages.find((p) => p.id === created.targetId) || pages[0];
  }
  if (!yt) throw new Error('No Chrome page target available');
  if (!cdpPageWs || cdpPageId !== yt.id || cdpPageWs.readyState !== WebSocket.OPEN) {
    await connectPage(yt);
  }
  if (url && yt.url !== url) {
    await cdpSend(cdpPageWs, 'Page.navigate', { url });
    await new Promise((r) => setTimeout(r, 1500));
  }
  return yt;
}

const PLAYER_FN = `(() => {
  const video = document.querySelector('video');
  const player = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
  function status() {
    let paused = true, currentTime = 0, duration = 0, volume = 1, muted = false;
    if (video) {
      paused = !!video.paused;
      currentTime = video.currentTime || 0;
      duration = video.duration && isFinite(video.duration) ? video.duration : 0;
      volume = typeof video.volume === 'number' ? video.volume : 1;
      muted = !!video.muted;
    }
    if (player && player.getPlayerState) {
      const st = player.getPlayerState();
      if (st === 1) paused = false;
      if (st === 2) paused = true;
    }
    if (player && player.getCurrentTime) try { currentTime = player.getCurrentTime() || currentTime; } catch (e) {}
    if (player && player.getDuration) try { const d = player.getDuration(); if (d && isFinite(d)) duration = d; } catch (e) {}
    if (player && player.getVolume) try { volume = (player.getVolume() || 0) / 100; } catch (e) {}
    if (player && player.isMuted) try { muted = !!player.isMuted(); } catch (e) {}
    const titleEl = document.querySelector('h1.ytd-watch-metadata yt-formatted-string, h1.title, h1');
    const channelEl = document.querySelector('#channel-name a, ytd-channel-name a, #owner #text a');
    let videoId = null;
    try {
      const u = new URL(location.href);
      if (u.pathname === '/watch') videoId = u.searchParams.get('v');
    } catch (e) {}
    return {
      title: (titleEl && titleEl.textContent || document.title || '').replace(/ - YouTube$/i,'').trim(),
      channel: channelEl && channelEl.textContent ? channelEl.textContent.trim() : '',
      videoId, url: location.href, paused, currentTime, duration, volume, muted,
    };
  }
  return { video, player, status };
})()`;

async function cdpEval(expression) {
  const result = await cdpSend(cdpPageWs, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || 'CDP evaluate failed');
  }
  return result.result && result.result.value;
}

function focusChromeWindow() {
  return new Promise((resolve) => {
    const ps = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinFocus {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  public static IntPtr FindYouTube() {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, sb.Capacity);
      var t = sb.ToString();
      if (t.IndexOf("YouTube", StringComparison.OrdinalIgnoreCase) >= 0 &&
          t.IndexOf("Chrome", StringComparison.OrdinalIgnoreCase) >= 0) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    if (found == IntPtr.Zero) {
      EnumWindows((h, l) => {
        if (!IsWindowVisible(h)) return true;
        var sb = new StringBuilder(512);
        GetWindowText(h, sb, sb.Capacity);
        var t = sb.ToString();
        if (t.IndexOf("Chrome", StringComparison.OrdinalIgnoreCase) >= 0) { found = h; return false; }
        return true;
      }, IntPtr.Zero);
    }
    return found;
  }
}
"@
$h = [WinFocus]::FindYouTube()
if ($h -ne [IntPtr]::Zero) {
  [WinFocus]::ShowWindow($h, 9) | Out-Null
  [WinFocus]::SetForegroundWindow($h) | Out-Null
  "focused"
} else { "not-found" }
`;
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.on('close', () => resolve(out.trim()));
    child.on('error', () => resolve('error'));
  });
}

async function cdpCommand(action, body = {}) {
  await ensureYouTubePage(action === 'load' ? (body.url || (body.videoId ? ('https://www.youtube.com/watch?v=' + body.videoId) : null)) : null);

  if (['load', 'play', 'togglePlay', 'showYouTube'].includes(action)) {
    await cdpSend(cdpPageWs, 'Page.bringToFront');
    await focusChromeWindow();
  }
  if (action === 'showYouTube') return { ok: true, mode: 'cdp', status: await cdpEval(PLAYER_FN + '.status()') };

  if (action === 'load') {
    const url = body.url || (body.videoId ? ('https://www.youtube.com/watch?v=' + body.videoId) : null);
    if (!url) throw new Error('videoId or url required');
    const safe = new URL(String(url));
    if (safe.protocol !== 'https:' || !/(^|\.)youtube\.com$/i.test(safe.hostname)) {
      throw new Error('Only HTTPS YouTube URLs supported');
    }
    await cdpSend(cdpPageWs, 'Page.navigate', { url: safe.href });
    await new Promise((r) => setTimeout(r, 2000));
    const status = await cdpEval(PLAYER_FN + '.status()');
    return { ok: true, mode: 'cdp', status };
  }

  const expr = `
    (async () => {
      const ctx = ${PLAYER_FN};
      const video = ctx.video;
      const player = ctx.player;
      const action = ${JSON.stringify(action)};
      const body = ${JSON.stringify(body)};
      function seekTo(seconds) {
        seconds = Math.max(0, Number(seconds) || 0);
        if (player && player.seekTo) player.seekTo(seconds, true);
        else if (video) video.currentTime = seconds;
      }
      function setVolume(vol) {
        vol = Math.max(0, Math.min(1, Number(vol) || 0));
        if (player && player.setVolume) player.setVolume(Math.round(vol * 100));
        if (video) { video.volume = vol; if (vol > 0) video.muted = false; }
      }
      switch (action) {
        case 'status': break;
        case 'togglePlay':
          if (player && player.getPlayerState) {
            if (player.getPlayerState() === 1) player.pauseVideo();
            else player.playVideo();
          } else if (video) {
            if (video.paused) {
              try { await video.play(); } catch (e) {
                const btn = document.querySelector('.ytp-large-play-button, .ytp-play-button, button.ytp-play-button');
                if (btn) btn.click();
              }
            } else video.pause();
          }
          break;
        case 'play':
          if (player && player.playVideo) player.playVideo();
          if (video) {
            try { await video.play(); } catch (e) {
              const btn = document.querySelector('.ytp-large-play-button, .ytp-play-button, button.ytp-play-button');
              if (btn) btn.click();
            }
          }
          break;
        case 'pause':
          if (player && player.pauseVideo) player.pauseVideo();
          else if (video) video.pause();
          break;
        case 'seekBy':
          seekTo((ctx.status().currentTime || 0) + (Number(body.seconds) || 0));
          break;
        case 'seekTo':
          seekTo(body.seconds);
          break;
        case 'setVolume':
          setVolume(body.volume);
          break;
        case 'volumeBy':
          setVolume((ctx.status().volume || 0) + (Number(body.delta) || 0));
          break;
        case 'toggleMute':
          if (player && player.isMuted) { if (player.isMuted()) player.unMute(); else player.mute(); }
          else if (video) video.muted = !video.muted;
          break;
        case 'next':
          if (player && player.nextVideo) player.nextVideo();
          else {
            const btn = document.querySelector('.ytp-next-button');
            if (btn) btn.click();
          }
          break;
        default:
          throw new Error('Unknown CDP action: ' + action);
      }
      return ctx.status();
    })()
  `;
  const status = await cdpEval(expr);
  return { ok: true, mode: 'cdp', status };
}

module.exports = {
  ensureChrome,
  cdpCommand,
  isCdpReady: async () => {
    try {
      const ver = await httpGet('http://127.0.0.1:' + CDP_PORT + '/json/version');
      return ver.status === 200;
    } catch (_) {
      return false;
    }
  },
};
