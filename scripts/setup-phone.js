#!/usr/bin/env node
'use strict';

// Turns on phone access: creates or updates config.local.json with
//   host 0.0.0.0, allowLan true, and a random authToken (only if none exists).
// An existing token is never replaced. The token itself is never printed.
// Usage: npm run setup-phone   (add --quiet for installer use)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const CONFIG = path.join(ROOT, 'config.local.json');
const EXAMPLE = path.join(ROOT, 'config.example.json');

function main() {
  let cfg = {};
  let created = false;
  if (fs.existsSync(CONFIG)) {
    try {
      cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8').replace(/^\uFEFF/, ''));
    } catch (e) {
      console.error('config.local.json is not valid JSON, so it was left untouched: ' + (e.message || e));
      console.error('Fix or delete config.local.json, then run this again.');
      process.exit(2);
    }
  } else {
    created = true;
    try { cfg = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8')); } catch (_) { cfg = {}; }
  }

  const changes = [];
  if (cfg.host !== '0.0.0.0') { cfg.host = '0.0.0.0'; changes.push('host set to 0.0.0.0 (listen on your home network)'); }
  if (cfg.allowLan !== true) { cfg.allowLan = true; changes.push('allowLan turned on'); }
  if (!cfg.port) cfg.port = 8790;

  let tokenNote;
  if (typeof cfg.authToken === 'string' && cfg.authToken.trim()) {
    tokenNote = 'kept your existing access token';
  } else {
    cfg.authToken = crypto.randomBytes(24).toString('base64url');
    tokenNote = 'created a new random access token';
    changes.push(tokenNote);
  }

  const tmp = CONFIG + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, CONFIG);

  const quiet = process.argv.includes('--quiet');
  console.log((created ? 'Created' : 'Updated') + ' config.local.json: ' + (changes.length ? changes.join(', ') : 'already set up') + (changes.includes(tokenNote) ? '' : ' (' + tokenNote + ')') + '.');
  if (!quiet) {
    console.log('');
    console.log('Next steps:');
    console.log('  1. Run "npm run open-firewall" in an admin terminal (lets your phone reach this PC on a Private network).');
    console.log('  2. Run "npm start" (restart it if it was already running).');
    console.log('  3. Scan the QR code it prints, or open http://127.0.0.1:' + cfg.port + '/ on this PC to see it.');
    console.log('The access token is saved in config.local.json. Keep that file private.');
  }
}

main();
