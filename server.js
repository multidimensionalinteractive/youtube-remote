'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const { loadConfig } = require('./lib/config');
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
    return isLoopbackAddress(req.socket.remoteAddress) || !!config.authToken;
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
  const remote = req.socket.remoteAddress;
  const loopback = isLoopbackAddress(remote);

  if (config.authToken) {
    const provided = getRequestToken(req, body);
    if (!timingSafeEqualString(provided, config.authToken)) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return false;
    }
  } else if (config.lanExposed && !loopback) {
    // Phone-on-WiFi without a shared secret is unsafe on many home networks (guest Wi-Fi, IoT, etc.).
    sendJson(res, 401, {
      error: 'LAN listening is enabled but authToken is empty. Set authToken in config.local.json or YT_REMOTE_AUTH_TOKEN.',
    });
    return false;
  }

  if (mutating && !csrfOk(req)) {
    sendJson(res, 403, { error: 'CSRF check failed (Origin/Referer/Host mismatch). Add your phone UI host to allowedHosts if needed.' });
    return false;
  }
  return true;
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    // Intentionally omit Access-Control-Allow-Origin: *. Same-origin UI does not need CORS.
  });
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

async function callBridgeOrNative(action, payload = {}, timeoutMs = 8000) {
  if (!MUTATING_ACTIONS.has(action) && action !== 'status') {
    throw new Error('Unsupported action');
  }
  if (action === 'wakePC') return wakePC();

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
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': contentType(filePath), 'Cache-Control': 'no-store' });
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
      // Health is intentionally unauthenticated for local diagnostics; it does not mutate state.
      sendJson(res, 200, {
        ok: true,
        bridgeConnected: state.bridgeConnected || await cdp.isCdpReady(),
        lastStatus: state.lastStatus,
        lastStatusAt: state.lastStatusAt,
        port: PORT,
        host: HOST,
        lanExposed: config.lanExposed,
        authRequired: !!config.authToken || !!config.lanExposed,
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
      // Inject only numeric/boolean values — never raw user strings into PowerShell.
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

wss.on('connection', (socket, req) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const role = url.searchParams.get('role') || 'ui';
  const token = url.searchParams.get('token') || '';
  const remote = req.socket.remoteAddress;
  const loopback = isLoopbackAddress(remote);

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
  } else if (config.lanExposed && !loopback) {
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

server.listen(PORT, HOST, () => {
  console.log('YouTube Remote listening on http://' + HOST + ':' + PORT);
  if (config.lanExposed) {
    console.log('[security] LAN bind enabled. Do NOT port-forward ' + PORT + ' to the internet.');
    if (!config.authToken) {
      console.log('[security] WARNING: no authToken set while LAN-exposed. Set YT_REMOTE_AUTH_TOKEN or config.local.json authToken.');
    }
  } else {
    console.log('[security] Loopback-only bind. Enable allowLan / YT_REMOTE_ALLOW_LAN deliberately for phone-on-WiFi use.');
  }
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
