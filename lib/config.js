'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function truthy(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return null;
}

function loadDotEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] == null || process.env[key] === '') process.env[key] = val;
  }
}

function readJsonConfig() {
  const localPath = path.join(ROOT, 'config.local.json');
  if (!fs.existsSync(localPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(localPath, 'utf8'));
  } catch (e) {
    throw new Error('Invalid config.local.json: ' + (e.message || e));
  }
}

function loadConfig() {
  loadDotEnv();
  const file = readJsonConfig();

  const allowLanEnv = truthy(process.env.YT_REMOTE_ALLOW_LAN);
  const allowLan = allowLanEnv != null ? allowLanEnv : !!file.allowLan;

  const hostFromEnv = process.env.YT_REMOTE_HOST;
  const host = (hostFromEnv && hostFromEnv.trim())
    || (file.host && String(file.host).trim())
    || (allowLan ? '0.0.0.0' : '127.0.0.1');

  const port = Number(process.env.YT_REMOTE_PORT || file.port || 8790);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error('Invalid port');
  }

  const authToken = String(
    process.env.YT_REMOTE_AUTH_TOKEN != null && process.env.YT_REMOTE_AUTH_TOKEN !== ''
      ? process.env.YT_REMOTE_AUTH_TOKEN
      : (file.authToken || '')
  ).trim();

  let allowedHosts = [];
  if (process.env.YT_REMOTE_ALLOWED_HOSTS) {
    allowedHosts = process.env.YT_REMOTE_ALLOWED_HOSTS.split(',').map((s) => s.trim()).filter(Boolean);
  } else if (Array.isArray(file.allowedHosts)) {
    allowedHosts = file.allowedHosts.map((s) => String(s).trim()).filter(Boolean);
  }

  const chromePath = process.env.CHROME_PATH
    || file.chromePath
    || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

  const chromeProfileDirectory = process.env.YT_REMOTE_CHROME_PROFILE_DIRECTORY
    || file.chromeProfileDirectory
    || 'Default';

  const chromeUserDataDir = process.env.YT_REMOTE_CHROME_USER_DATA_DIR
    || file.chromeUserDataDir
    || '';

  const cdpPort = Number(process.env.YT_REMOTE_CDP_PORT || file.cdpPort || 9333);
  const cdpProfileDir = process.env.YT_REMOTE_CHROME_PROFILE
    || file.cdpProfileDir
    || path.join(ROOT, 'chrome-profile');

  // Safety: if allowLan and no token and no allowlist, warn loudly (still start — operator choice).
  const lanExposed = allowLan || host === '0.0.0.0' || host === '::';

  return {
    root: ROOT,
    host,
    port,
    allowLan: !!allowLan || lanExposed,
    authToken,
    allowedHosts,
    chromePath,
    chromeProfileDirectory,
    chromeUserDataDir,
    cdpPort,
    cdpProfileDir,
    lanExposed,
  };
}

module.exports = { loadConfig, ROOT };
