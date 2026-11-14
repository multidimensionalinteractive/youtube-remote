'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const phone = require('../lib/phone');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

// Documentation-range style example addresses only (no real network data).
const IFACES = {
  'vEthernet (WSL)': [{ family: 'IPv4', address: '172.20.0.1', internal: false }],
  'vEthernet (Default Switch)': [{ family: 'IPv4', address: '172.21.0.1', internal: false }],
  'Ethernet 2': [
    { family: 'IPv4', address: '10.0.0.20', internal: false },
    { family: 'IPv4', address: '169.254.10.10', internal: false },
  ],
  'Wi-Fi': [
    { family: 'IPv6', address: 'fe80::1', internal: false },
    { family: 'IPv4', address: '192.168.1.50', internal: false },
  ],
  'Tailscale': [{ family: 'IPv4', address: '100.64.0.5', internal: false }],
  'Docker Desktop': [{ family: 'IPv4', address: '172.17.0.1', internal: false }],
  'Loopback Pseudo-Interface 1': [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
};

describe('phone link addresses', () => {
  it('keeps only private IPv4 on real adapters, Wi-Fi first', () => {
    const list = phone.lanAddresses(IFACES);
    assert.deepEqual(list.map((a) => a.address), ['192.168.1.50', '10.0.0.20']);
    assert.equal(list[0].name, 'Wi-Fi');
  });

  it('classifies private ranges', () => {
    for (const ip of ['10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.0.1']) assert.ok(phone.isPrivateIPv4(ip), ip);
    for (const ip of ['169.254.1.1', '127.0.0.1', '100.64.0.1', '172.32.0.1', '8.8.8.8', 'x']) assert.ok(!phone.isPrivateIPv4(ip), ip);
  });

  it('builds token links (URL-encoded) and none when LAN is off', () => {
    const cfg = { lanExposed: true, host: '0.0.0.0', port: 8790, authToken: 'a b&c' };
    const links = phone.phoneLinks(cfg, IFACES);
    assert.equal(links[0].url, 'http://192.168.1.50:8790/?token=a%20b%26c');
    assert.equal(links[0].plainUrl, 'http://192.168.1.50:8790/');
    assert.deepEqual(phone.phoneLinks({ ...cfg, lanExposed: false }, IFACES), []);
    assert.equal(phone.phoneLinks({ ...cfg, authToken: '' }, IFACES)[0].url, 'http://192.168.1.50:8790/');
  });

  it('startup banner warns about the token, or explains how to enable phone access', () => {
    const on = phone.startupLines({ lanExposed: true, host: '0.0.0.0', port: 8790, authToken: 't' }, IFACES);
    assert.match(on.lines.join('\n'), /contains your access token/);
    assert.ok(on.qr.length > 100);
    const off = phone.startupLines({ lanExposed: false, port: 8790 }, IFACES);
    assert.equal(off.qr, '');
    assert.match(off.lines[0], /npm run setup-phone/);
  });
});

describe('QR rendering', () => {
  const text = 'http://192.168.1.50:8790/?token=example';
  const m = phone.qrMatrix(text);

  it('terminal QR matches the matrix (light modules drawn, 2 rows per line)', () => {
    const lines = phone.qrTerminal(text).split('\n');
    const q = 2;
    const n = m.length;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const ch = lines[Math.floor((r + q) / 2)][c + q];
        const topHalf = (r + q) % 2 === 0;
        const light = topHalf ? (ch === '\u2588' || ch === '\u2580') : (ch === '\u2588' || ch === '\u2584');
        assert.equal(light, !m[r][c]);
      }
    }
  });

  it('SVG has one square per dark module', () => {
    const svg = phone.qrSvg(text);
    const dark = m.flat().filter(Boolean).length;
    assert.equal((svg.match(/h6v6h-6z/g) || []).length, dark);
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  });
});

describe('PC-only "Connect your phone" panel', () => {
  const server = read('server.js');
  const ui = read('public/index.html');

  it('endpoint is guarded: direct loopback, loopback Host, not cross-site', () => {
    assert.match(server, /pathname === '\/api\/phone-link'[\s\S]*?if \(!isPcLocalPageRequest\(req\)\)/);
    assert.match(server, /function isPcLocalPageRequest\(req\) \{\n  if \(!isLocalRequest\(req\)\) return false;/);
    assert.match(server, /\['127\.0\.0\.1', 'localhost', '\[::1\]'\]\.includes\(host\)/);
    assert.match(server, /sec-fetch-site/);
  });

  it('UI only asks for it on 127.0.0.1 / localhost', () => {
    assert.match(ui, /const IS_PC_PAGE = \['127\.0\.0\.1', 'localhost'/);
    assert.match(ui, /if \(!IS_PC_PAGE\) return;/);
    assert.match(ui, /id="connectBox"/);
  });

  it('prints the phone link and QR on startup', () => {
    assert.match(server, /phone\.startupLines\(config\)/);
  });
});

describe('setup-phone', () => {
  it('creates LAN config with a random token and never replaces an existing one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytr-setup-'));
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.copyFileSync(path.join(root, 'scripts/setup-phone.js'), path.join(dir, 'scripts/setup-phone.js'));
    fs.copyFileSync(path.join(root, 'config.example.json'), path.join(dir, 'config.example.json'));
    const run = () => execFileSync(process.execPath, [path.join(dir, 'scripts/setup-phone.js'), '--quiet'], { encoding: 'utf8' });
    const out1 = run();
    const cfg1 = JSON.parse(fs.readFileSync(path.join(dir, 'config.local.json'), 'utf8'));
    assert.equal(cfg1.host, '0.0.0.0');
    assert.equal(cfg1.allowLan, true);
    assert.ok(cfg1.authToken.length >= 32);
    assert.ok(!out1.includes(cfg1.authToken), 'token must not be printed');
    run();
    const cfg2 = JSON.parse(fs.readFileSync(path.join(dir, 'config.local.json'), 'utf8'));
    assert.equal(cfg2.authToken, cfg1.authToken);
    fs.writeFileSync(path.join(dir, 'config.local.json'), JSON.stringify({ authToken: 'mine', port: 9000 }));
    run();
    const cfg3 = JSON.parse(fs.readFileSync(path.join(dir, 'config.local.json'), 'utf8'));
    assert.equal(cfg3.authToken, 'mine');
    assert.equal(cfg3.port, 9000);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is wired as npm run setup-phone', () => {
    assert.equal(JSON.parse(read('package.json')).scripts['setup-phone'], 'node scripts/setup-phone.js');
  });
});

describe('Windows installer', () => {
  const files = ['install.cmd', 'uninstall.cmd', 'scripts/install.ps1', 'scripts/uninstall.ps1', 'scripts/common-install.ps1', 'scripts/open-firewall.ps1'];

  it('files exist and are plain ASCII (safe for Windows PowerShell 5.1)', () => {
    for (const f of files) assert.doesNotMatch(read(f), /[^\x00-\x7F]/, f);
  });

  it('never force-closes Chrome and only stops its own node server', () => {
    const all = files.map(read).join('\n');
    assert.doesNotMatch(all, /taskkill|Stop-Process[^\n]*chrome|-Name chrome/i);
    assert.match(read('scripts/common-install.ps1'), /\$proc\.Name -eq 'node\.exe' -and \$proc\.CommandLine -match 'server\\\.js'/);
  });

  it('elevates only for the firewall step', () => {
    const all = files.map(read).join('\n');
    assert.equal((all.match(/-Verb RunAs/g) || []).length, 1);
    assert.match(read('scripts/common-install.ps1'), /open-firewall\.ps1/);
  });

  it('covers every install step and stops when run from inside a ZIP', () => {
    const ps = read('scripts/install.ps1');
    for (const s of ['OpenJS.NodeJS.LTS', 'yt-dlp.yt-dlp', 'npm.cmd install', 'setup-phone.js', 'Invoke-FirewallScript', 'install-startup-folder.ps1', 'start-hidden.vbs', 'chrome://extensions/', 'Load unpacked', '/#connect', 'uninstall.cmd']) {
      assert.ok(ps.includes(s), s);
    }
    assert.match(read('install.cmd'), /if not exist "%~dp0server\.js"/);
  });

  it('does not print the access token in the installer window', () => {
    const ps = read('scripts/install.ps1');
    assert.doesNotMatch(ps, /\$info\.token|\.authToken/);
  });

  it('keeps CRLF line endings for Windows scripts', () => {
    assert.match(read('.gitattributes'), /\*\.cmd text eol=crlf/);
    assert.match(read('.gitattributes'), /\*\.ps1 text eol=crlf/);
  });
});
