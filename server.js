'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const { loadConfig } = require('./lib/config');
const phone = require('./lib/phone');
const cdp = require('./cdp');

const config = loadConfig();
const PORT = config.port;
const HOST = config.host;
const PUBLIC = path.join(config.root, 'public');

const MUTATING_ACTIONS = new Set([
  'wakePC', 'showYouTube', 'ensureChrome', 'load',
  'togglePlay', 'play', 'pause', 'prev', 'next',
  'volumeBy', 'setVolume', 'toggleMute', 'mute', 'unmute',
  'seekBy', 'seekTo', 'setBass', 'bassBy', 'reloadExtension', 'cleanupYouTube',
  'screensOff', 'setStopAfter', 'toggleStopAfter',
]);

const state = {
  bridgeConnected: false,
  lastStatus: null,
  lastStatusAt: null,
};

let bridgeSocket = null;
const uiClients = new Set();
const pending = new Map();
let basicStatus = null;
let basicPolling = false;
let reqId = 1;

function timingSafeEqualString(a, b) {
  const aa = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (aa.length !== bb.length) {
    // Compare against self to keep runtime roughly constant when lengths differ.
    crypto.timingSafeEqual(aa, aa);
    return false;
  }
  return crypto.timingSafeEqual(aa, bb);
}

function getRequestToken(req, body) {
  const header = req.headers['x-yt-remote-token'] || req.headers['authorization'] || '';
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
  if (typeof header === 'string' && header.trim() && !header.toLowerCase().startsWith('bearer ')) {
    // Accept raw token in X-YT-Remote-Token
    if (req.headers['x-yt-remote-token']) return String(req.headers['x-yt-remote-token']).trim();
  }
  const u = new URL(req.url || '/', 'http://127.0.0.1');
  if (u.searchParams.get('token')) return u.searchParams.get('token');
  if (body && typeof body.token === 'string') return body.token.trim();
  return '';
}

function isLoopbackAddress(addr) {
  if (!addr) return false;
  const a = String(addr).replace(/^::ffff:/, '');
  return a === '127.0.0.1' || a === '::1' || a === 'localhost';
}

// A request only counts as "local" when it comes from loopback AND was not relayed
// by a reverse proxy on the same PC (for example `tailscale serve` for HTTPS).
// Proxied requests arrive from 127.0.0.1, so without this check every proxied
// client would get loopback trust (no token, bridge access).
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'x-real-ip', 'tailscale-user-login', 'tailscale-user-name', 'tailscale-headers-info'];
function isProxied(req) {
  const h = (req && req.headers) || {};
  return PROXY_HEADERS.some((k) => h[k] != null && String(h[k]).length > 0);
}
function isLocalRequest(req) {
  return isLoopbackAddress(req && req.socket && req.socket.remoteAddress) && !isProxied(req);
}

// True only for the PC's own browser talking to this server directly.
function isPcLocalPageRequest(req) {
  if (!isLocalRequest(req)) return false;
  const host = parseHostHeader(req.headers.host).replace(/:\d+$/, '');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) return false;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  return true;
}

function parseHostHeader(hostHeader) {
  if (!hostHeader) return '';
  return String(hostHeader).trim().toLowerCase();
}

function originHost(originOrReferer) {
  if (!originOrReferer) return '';
  try {
    const u = new URL(originOrReferer);
    return (u.host || '').toLowerCase();
  } catch {
    return '';
  }
}

function csrfOk(req) {
  // Same-origin browser clients send Origin or Referer. Non-browser / same-machine tools may omit both.
  const host = parseHostHeader(req.headers.host);
  const origin = originHost(req.headers.origin);
  const referer = originHost(req.headers.referer);

  if (!origin && !referer) {
    // Allow token-authenticated or loopback clients without Origin (curl, scripts, extension bridge via HTTP rarely).
    return isLocalRequest(req) || !!config.authToken;
  }

  const candidate = origin || referer;
  if (candidate && host && candidate === host) return true;

  if (config.allowedHosts.length) {
    return config.allowedHosts.some((h) => h.toLowerCase() === candidate);
  }

  // When LAN is enabled without an allowlist, require exact Host match already handled above.
  return false;
}

function requireAuth(req, res, body, { mutating }) {
  const loopback = isLocalRequest(req);

  if (config.authToken) {
    const provided = getRequestToken(req, body);
    if (!timingSafeEqualString(provided, config.authToken)) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return false;
    }
  } else if ((config.lanExposed || isProxied(req)) && !loopback) {
    // Phone-on-WiFi without a shared secret is unsafe on many home networks (guest Wi-Fi, IoT, etc.).
    sendJson(res, 401, {
      error: (isProxied(req) ? 'Request came through a proxy (for example tailscale serve)' : 'LAN listening is enabled')
        + ' but authToken is empty. Set authToken in config.local.json or YT_REMOTE_AUTH_TOKEN.',
    });
    return false;
  }

  if (mutating && !csrfOk(req)) {
    sendJson(res, 403, { error: 'CSRF check failed (Origin/Referer/Host mismatch). Add your phone UI host to allowedHosts if needed.' });
    return false;
  }
  return true;
}

function securityHeaders(extra = {}) {
  return {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    // Intentionally omit Access-Control-Allow-Origin: *. Same-origin UI does not need CORS.
    ...extra,
  };
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, securityHeaders({ 'Content-Type': 'application/json' }));
  res.end(body);
}

function broadcast(obj) {
  const raw = JSON.stringify(obj);
  for (const c of uiClients) {
    if (c.readyState === 1) c.send(raw);
  }
}

function runPowershell(command) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], { windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c.toString(); });
    child.stderr.on('data', (c) => { err += c.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(err.trim() || out.trim() || ('powershell exited ' + code)));
      else resolve(out.trim());
    });
  });
}

function runPowershellFile(scriptPath, extraPrefix = '') {
  const abs = path.resolve(scriptPath);
  const scriptsRoot = path.resolve(path.join(config.root, 'scripts')) + path.sep;
  if (abs !== path.resolve(path.join(config.root, 'scripts')) && !abs.toLowerCase().startsWith(scriptsRoot.toLowerCase())) {
    return Promise.reject(new Error('Script path not allowed'));
  }
  const text = (extraPrefix || '') + fs.readFileSync(abs, 'utf8');
  return runPowershell(text);
}

// Runs an allowlisted script with powershell -File (not -Command) so it executes
// as a real script file in the server's interactive desktop session. Needed for
// window messages such as SC_MONITORPOWER that must reach the logged-in desktop.
function runPowershellScriptFile(scriptPath) {
  const abs = path.resolve(scriptPath);
  const scriptsRoot = path.resolve(path.join(config.root, 'scripts')) + path.sep;
  if (!abs.toLowerCase().startsWith(scriptsRoot.toLowerCase())) {
    return Promise.reject(new Error('Script path not allowed'));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', abs],
      { windowsHide: true, cwd: path.dirname(abs) }
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c.toString(); });
    child.stderr.on('data', (c) => { err += c.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(err.trim() || out.trim() || ('powershell file exited ' + code)));
      else resolve(out.trim());
    });
  });
}

async function refreshBasicStatus() {
  if (basicPolling || state.bridgeConnected) return;
  basicPolling = true;
  try {
    const raw = await runPowershellFile(path.join(config.root, 'scripts', 'basic-status.ps1'));
    basicStatus = raw === 'null' ? null : JSON.parse(raw);
    broadcast({ type: 'basic', basicMode: !!basicStatus, status: basicStatus });
  } catch (_) {
    // ignore polling failures
  } finally {
    basicPolling = false;
  }
}
setInterval(refreshBasicStatus, 8000);
setTimeout(refreshBasicStatus, 1000);

function sendMediaKey(key) {
  const map = {
    playpause: 179,
    next: 176,
    prev: 177,
    voldown: 174,
    volup: 175,
    mute: 173,
  };
  const vk = map[key];
  if (!vk) return Promise.reject(new Error('unknown media key'));
  const ps = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class MediaKeys {
  [DllImport("user32.dll")]
  public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@
[MediaKeys]::keybd_event(${vk}, 0, 0, [UIntPtr]::Zero)
[MediaKeys]::keybd_event(${vk}, 0, 2, [UIntPtr]::Zero)
`;
  return runPowershell(ps);
}

function assertYouTubeHttpsUrl(url) {
  const safeUrl = new URL(String(url));
  if (safeUrl.protocol !== 'https:') throw new Error('Only HTTPS YouTube URLs supported');
  const host = safeUrl.hostname.toLowerCase();
  if (!['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(host)) {
    throw new Error('Only YouTube URLs supported');
  }
  return safeUrl;
}

async function openYouTubeUrl(url) {
  const safeUrl = assertYouTubeHttpsUrl(url);
  const chrome = config.chromePath;
  const args = [];
  if (config.chromeUserDataDir) args.push('--user-data-dir=' + config.chromeUserDataDir);
  if (config.chromeProfileDirectory) args.push('--profile-directory=' + config.chromeProfileDirectory);
  args.push(safeUrl.href);
  await new Promise((resolve, reject) => {
    const child = spawn(chrome, args, { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
  return { ok: true, mode: 'native-chrome', opened: safeUrl.href };
}

async function nativeCommand(action, body) {
  switch (action) {
    case 'showYouTube': {
      const focusResult = await runPowershellFile(path.join(config.root, 'scripts', 'show-youtube.ps1'));
      if (focusResult.trim() === 'NO_CHROME') {
        return openYouTubeUrl('https://www.youtube.com/');
      }
      return { ok: focusResult.includes('SELECTED:'), mode: 'native-uia', focusResult };
    }
    case 'load': {
      const url = assertYouTubeHttpsUrl(body.url || ('https://www.youtube.com/watch?v=' + encodeURIComponent(body.videoId || '')));
      const scriptPath = path.join(config.root, 'scripts', 'load-existing-youtube.ps1');
      const showPath = path.join(config.root, 'scripts', 'show-youtube.ps1');
      const prefix = "$TargetUrl='" + url.href.replace(/'/g, "''") + "';\n"
        + "$ShowYouTubeScript='" + showPath.replace(/'/g, "''") + "';\n";
      const result = await runPowershellFile(scriptPath, prefix);
      refreshBasicStatus();
      return { ok: true, mode: 'existing-tab', details: result };
    }
    case 'togglePlay':
    case 'play':
    case 'pause':
      await sendMediaKey('playpause');
      return { ok: true, mode: 'native' };
    case 'prev':
      await sendMediaKey('prev');
      return { ok: true, mode: 'native' };
    case 'next': {
      const focusResult = await runPowershellFile(path.join(config.root, 'scripts', 'show-youtube.ps1'));
      if (!focusResult.includes('foreground=True')) throw new Error('Could not foreground YouTube; Next not sent');
      await runPowershell("$s=New-Object -ComObject WScript.Shell; $s.SendKeys('+n')");
      setTimeout(refreshBasicStatus, 2000);
      return { ok: true, mode: 'youtube-keyboard' };
    }
    case 'volumeBy': {
      const delta = Number(body.delta) || 0;
      await sendMediaKey(delta < 0 ? 'voldown' : 'volup');
      return { ok: true, mode: 'native' };
    }
    case 'toggleMute':
    case 'mute':
    case 'unmute':
      await sendMediaKey('mute');
      return { ok: true, mode: 'native' };
    case 'setVolume':
    case 'seekBy':
    case 'seekTo':
    case 'setBass':
    case 'bassBy':
    case 'status':
      throw new Error('Bridge offline. Load the Chrome extension and open a YouTube tab for precise ' + action + '. Basic play/pause/next/volume keys still work.');
    default:
      throw new Error('Unsupported without bridge: ' + action);
  }
}

async function wakePC() {
  await runPowershell(`
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WakeMouse {
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int x, int y, uint d, UIntPtr e);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
}
"@
$p = New-Object WakeMouse+POINT
[WakeMouse]::GetCursorPos([ref]$p) | Out-Null
[WakeMouse]::mouse_event(1, 1, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 100
[WakeMouse]::SetCursorPos($p.X, $p.Y) | Out-Null
`);
  return { ok: true, mode: 'interactive-mouse', message: 'Mouse moved and restored' };
}

// Turns the monitors off without sleeping or locking the PC. Playback keeps going.
// Only an explicit wakePC (or local mouse/keyboard input) turns them back on;
// status polling never does.
async function screensOff() {
  const out = await runPowershellScriptFile(path.join(config.root, 'scripts', 'screens-off.ps1'));
  return { ok: true, mode: 'monitor-power', message: String(out || '').trim().split(/\r?\n/).pop() || 'MONITORS_OFF_DONE' };
}

async function callBridgeOrNative(action, payload = {}, timeoutMs = 8000) {
  if (!MUTATING_ACTIONS.has(action) && action !== 'status') {
    throw new Error('Unsupported action');
  }
  if (action === 'wakePC') return wakePC();
  if (action === 'screensOff') return screensOff();

  if (bridgeSocket && bridgeSocket.readyState === 1) {
    return callBridge(action, payload, timeoutMs);
  }
  if (action === 'ensureChrome') {
    await cdp.ensureChrome();
    return { ok: true, mode: 'cdp' };
  }
  try {
    if (await cdp.isCdpReady()) {
      return await cdp.cdpCommand(action, payload);
    }
  } catch (_) {
    // fall through
  }
  return nativeCommand(action, payload);
}

function callBridge(action, payload = {}, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    if (!bridgeSocket || bridgeSocket.readyState !== 1) {
      reject(new Error('YouTube bridge not connected. Open YouTube in Chrome with the extension loaded.'));
      return;
    }
    const id = reqId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Bridge timed out on action: ' + action));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    bridgeSocket.send(JSON.stringify({ id, action, ...payload }));
  });
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ({
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
  })[ext] || 'application/octet-stream';
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC, urlPath));
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, securityHeaders()); res.end('Not found'); return; }
    const type = contentType(filePath);
    const headers = securityHeaders({ 'Content-Type': type });
    // Inline UI needs script/style/img/connect to same origin + YouTube thumbnails.
    if (type.startsWith('text/html')) {
      headers['Content-Security-Policy'] = [
        "default-src 'self'",
        "base-uri 'self'",
        "frame-ancestors 'none'",
        "form-action 'self'",
        "img-src 'self' https://i.ytimg.com data:",
        "media-src 'none'",
        "object-src 'none'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "connect-src 'self' ws: wss:",
      ].join('; ');
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}

async function searchYouTube(query, limit = 10) {
  const q = String(query || '').trim();
  if (!q) return [];
  const n = Math.max(1, Math.min(20, Number(limit) || 10));
  const args = [
    'ytsearch' + n + ':' + q,
    '--flat-playlist',
    '--dump-json',
    '--no-download',
    '--no-warnings',
    '--socket-timeout', '15',
  ];
  return new Promise((resolve, reject) => {
    const child = spawn('yt-dlp', args, { windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c.toString(); });
    child.stderr.on('data', (c) => { err += c.toString(); });
    child.on('error', (e) => reject(e));
    child.on('close', (code) => {
      if (code !== 0 && !out.trim()) {
        reject(new Error(err.trim() || ('yt-dlp exited ' + code)));
        return;
      }
      const results = [];
      for (const line of out.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const j = JSON.parse(line);
          const id = j.id || j.url;
          if (!id) continue;
          results.push({
            id: String(id),
            title: j.title || 'Untitled',
            channel: j.channel || j.uploader || '',
            duration: j.duration || j.duration_string || null,
            url: 'https://www.youtube.com/watch?v=' + id,
            thumbnail: j.thumbnail || ('https://i.ytimg.com/vi/' + id + '/hqdefault.jpg'),
          });
        } catch (_) {}
      }
      resolve(results);
    });
  });
}

async function handleApi(req, res, pathname) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-YT-Remote-Token',
    });
    res.end();
    return;
  }

  const readBody = () => new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { resolve({}); }
    });
  });

  try {
    if (pathname === '/api/health' && req.method === 'GET') {
      // Unauthenticated health is intentionally minimal (no now-playing / titles).
      const payload = {
        ok: true,
        bridgeConnected: state.bridgeConnected || await cdp.isCdpReady(),
        lastStatusAt: state.lastStatusAt,
        port: PORT,
        host: HOST,
        lanExposed: config.lanExposed,
        authRequired: !!config.authToken || !!config.lanExposed,
      };
      // Include lastStatus only for loopback or authenticated callers.
      const body = {};
      const authed = !!(config.authToken && timingSafeEqualString(getRequestToken(req, body), config.authToken));
      if (isLocalRequest(req) || authed) {
        payload.lastStatus = state.lastStatus;
      }
      sendJson(res, 200, payload);
      return;
    }

    if (pathname === '/api/phone-link' && req.method === 'GET') {
      // "Connect your phone" panel for the PC's own browser. The link contains the
      // access token, so it is only served to a direct loopback request (not via a
      // proxy), addressed to 127.0.0.1/localhost (blocks DNS rebinding), and not
      // from another site. Everyone else gets a plain 404.
      if (!isPcLocalPageRequest(req)) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      const links = phone.phoneLinks(config);
      sendJson(res, 200, {
        lanExposed: config.lanExposed,
        hasToken: !!config.authToken,
        token: config.authToken || '',
        port: PORT,
        links: links.map((l) => ({ adapter: l.adapter, address: l.address, url: l.url })),
        qrSvg: links.length ? phone.qrSvg(links[0].url) : '',
      });
      return;
    }

    if (pathname === '/api/system-volume') {
      const body = req.method === 'POST' ? await readBody() : {};
      const mutating = req.method === 'POST' && (typeof body.volume === 'number' || typeof body.muted === 'boolean');
      if (!requireAuth(req, res, body, { mutating: mutating || req.method === 'POST' })) return;

      let script = fs.readFileSync(path.join(config.root, 'scripts', 'system-volume.ps1'), 'utf8');
      const level = typeof body.volume === 'number' ? Math.max(0, Math.min(1, body.volume)) : -1;
      const mute = typeof body.muted === 'boolean' ? String(body.muted) : '';
      // Inject only numeric/boolean values, never raw user strings into PowerShell.
      script = script.replace(
        "param([double]$Level=-1,[string]$Mute='')",
        '$Level=' + level + ";$Mute='" + mute.replace(/[^a-z]/gi, '') + "'"
      );
      sendJson(res, 200, JSON.parse(await runPowershell(script)));
      return;
    }

    if (pathname === '/api/status' && req.method === 'GET') {
      if (!requireAuth(req, res, {}, { mutating: false })) return;
      if (!state.bridgeConnected && !(await cdp.isCdpReady())) {
        sendJson(res, 200, { bridgeConnected: false, basicMode: !!basicStatus, status: basicStatus });
        return;
      }
      try {
        const response = await callBridgeOrNative('status', {}, 4000);
        const status = response.status || response;
        state.lastStatus = status;
        state.lastStatusAt = Date.now();
        sendJson(res, 200, { bridgeConnected: true, status });
      } catch (e) {
        sendJson(res, 200, {
          bridgeConnected: state.bridgeConnected || await cdp.isCdpReady(),
          status: state.lastStatus,
          error: e.message,
        });
      }
      return;
    }

    if (pathname === '/api/search' && req.method === 'GET') {
      if (!requireAuth(req, res, {}, { mutating: false })) return;
      const u = new URL(req.url, 'http://127.0.0.1');
      const q = u.searchParams.get('q') || '';
      const results = await searchYouTube(q, u.searchParams.get('limit') || 10);
      sendJson(res, 200, { query: q, results });
      return;
    }

    if (pathname === '/api/command' && req.method === 'POST') {
      const body = await readBody();
      if (!requireAuth(req, res, body, { mutating: true })) return;
      const action = body.action;
      if (!action || !MUTATING_ACTIONS.has(action)) {
        sendJson(res, 400, { error: 'unsupported or missing action' });
        return;
      }
      const result = await callBridgeOrNative(action, body);
      if (result && result.status) {
        state.lastStatus = result.status;
        state.lastStatusAt = Date.now();
        broadcast({ type: 'status', status: result.status, bridgeConnected: true });
      }
      sendJson(res, 200, { ok: true, result });
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    sendJson(res, 500, { error: e.message || String(e) });
  }
}

const server = http.createServer((req, res) => {
  const pathname = (req.url || '/').split('?')[0];
  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname);
    return;
  }
  serveStatic(req, res);
});

const wss = new WebSocketServer({ server });
// Listen errors are handled on `server` (clear message for a busy port); ws re-emits them here.
wss.on('error', () => {});

wss.on('connection', (socket, req) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const role = url.searchParams.get('role') || 'ui';
  const token = url.searchParams.get('token') || '';
  const loopback = isLocalRequest(req);

  if (role === 'bridge') {
    // Extension bridge must come from the same machine.
    if (!loopback) {
      socket.close(1008, 'bridge must be local');
      return;
    }
    if (bridgeSocket && bridgeSocket !== socket) {
      try { bridgeSocket.close(); } catch (_) {}
    }
    bridgeSocket = socket;
    state.bridgeConnected = true;
    broadcast({ type: 'bridge', bridgeConnected: true });
    console.log('[bridge] connected');

    socket.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg && msg.type === 'status') {
        state.lastStatus = msg.status;
        state.lastStatusAt = Date.now();
        broadcast({ type: 'status', status: msg.status, bridgeConnected: true });
        return;
      }
      if (msg && msg.id != null && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error));
        else p.resolve(msg.result);
      }
    });

    socket.on('close', () => {
      if (bridgeSocket === socket) {
        bridgeSocket = null;
        state.bridgeConnected = false;
        broadcast({ type: 'bridge', bridgeConnected: false });
        console.log('[bridge] disconnected');
      }
    });
    return;
  }

  // UI websocket
  if (config.authToken) {
    if (!timingSafeEqualString(token, config.authToken)) {
      socket.close(1008, 'unauthorized');
      return;
    }
  } else if ((config.lanExposed || isProxied(req)) && !loopback) {
    socket.close(1008, 'auth token required for LAN');
    return;
  }

  uiClients.add(socket);
  socket.send(JSON.stringify({
    type: 'hello',
    bridgeConnected: state.bridgeConnected,
    status: state.lastStatus,
  }));
  socket.on('close', () => uiClients.delete(socket));
});

// PID file lets the installer and uninstaller stop exactly this server.
const PID_FILE = path.join(config.root, '.server.pid');
function removePidFile() {
  try {
    if (fs.readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) fs.unlinkSync(PID_FILE);
  } catch (_) {}
}

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error('Port ' + PORT + ' is already in use. Another copy of YouTube Remote may already be running.');
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, HOST, () => {
  try { fs.writeFileSync(PID_FILE, String(process.pid)); } catch (_) {}
  console.log('YouTube Remote listening on http://' + HOST + ':' + PORT);
  if (config.lanExposed) {
    console.log('[security] LAN bind enabled. Do NOT port-forward ' + PORT + ' to the internet.');
    if (!config.authToken) {
      console.log('[security] WARNING: no authToken set while LAN-exposed. Set YT_REMOTE_AUTH_TOKEN or config.local.json authToken.');
    }
  } else {
    console.log('[security] Loopback-only bind. Enable allowLan / YT_REMOTE_ALLOW_LAN deliberately for phone-on-WiFi use.');
  }
  try {
    const banner = phone.startupLines(config);
    for (const line of banner.lines) console.log(line);
    if (banner.qr) console.log(banner.qr);
  } catch (e) {
    console.log('[phone] Could not build the phone link: ' + (e.message || e));
  }
});

process.on('exit', removePidFile);
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
