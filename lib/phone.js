'use strict';

// Helpers for "Connect your phone": find this PC's home network address(es),
// build the phone link, and draw it as a QR code (terminal and SVG).

const os = require('os');
const QRCode = require('qrcode-terminal/vendor/QRCode');
const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');

// Virtual / VPN adapters that a phone on the home Wi-Fi cannot reach.
const SKIP_ADAPTER = /vethernet|wsl|hyper-?v|default switch|docker|virtualbox|vbox|vmware|vmnet|loopback|pseudo|tailscale|zerotier|wireguard|openvpn|vpn|\btun|\btap|bluetooth|^br-|^veth|^virbr|^lxc|^podman|^utun|^awdl|^llw/i;

function isPrivateIPv4(ip) {
  const p = String(ip).split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  if (p[0] === 10) return true;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  return false;
}

function adapterRank(name) {
  if (/wi-?fi|wlan|wireless|airport/i.test(name)) return 0;
  if (/ethernet|^eth|^en[0-9ops]|^lan/i.test(name)) return 1;
  return 2;
}

// Returns [{ name, address }] best first. `interfaces` is injectable for tests.
function lanAddresses(interfaces = os.networkInterfaces()) {
  const out = [];
  for (const [name, list] of Object.entries(interfaces || {})) {
    if (SKIP_ADAPTER.test(name)) continue;
    for (const info of list || []) {
      const fam = info.family === 4 ? 'IPv4' : info.family;
      if (fam !== 'IPv4' || info.internal) continue;
      if (!isPrivateIPv4(info.address)) continue; // also drops 169.254.x.x and 127.x
      out.push({ name, address: info.address });
    }
  }
  out.sort((a, b) => {
    const r = adapterRank(a.name) - adapterRank(b.name);
    if (r) return r;
    const a192 = a.address.startsWith('192.168.') ? 0 : 1;
    const b192 = b.address.startsWith('192.168.') ? 0 : 1;
    return a192 - b192;
  });
  return out;
}

function phoneUrl(address, port, token) {
  return 'http://' + address + ':' + port + '/' + (token ? '?token=' + encodeURIComponent(token) : '');
}

// Phone links for this config, best first. Empty when LAN access is off.
function phoneLinks(config, interfaces) {
  if (!config.lanExposed) return [];
  const wildcard = config.host === '0.0.0.0' || config.host === '::' || !config.host;
  const addrs = wildcard
    ? lanAddresses(interfaces)
    : (isPrivateIPv4(config.host) ? [{ name: 'configured host', address: config.host }] : []);
  return addrs.map((a) => ({
    adapter: a.name,
    address: a.address,
    url: phoneUrl(a.address, config.port, config.authToken),
    plainUrl: phoneUrl(a.address, config.port, ''),
  }));
}

function qrMatrix(text) {
  const qr = new QRCode(-1, QRErrorCorrectLevel.M);
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const rows = [];
  for (let r = 0; r < n; r++) {
    const row = [];
    for (let c = 0; c < n; c++) row.push(qr.isDark(r, c));
    rows.push(row);
  }
  return rows;
}

// Compact terminal QR using half blocks (2 rows per line), with a quiet zone.
function qrTerminal(text) {
  const m = qrMatrix(text);
  const n = m.length;
  const q = 2;
  const dark = (r, c) => r >= 0 && c >= 0 && r < n && c < n && m[r][c];
  const lines = [];
  for (let r = -q; r < n + q; r += 2) {
    let line = '';
    for (let c = -q; c < n + q; c++) {
      const top = dark(r, c);
      const bottom = dark(r + 1, c);
      // Light modules are drawn, dark ones are blank, so it scans on dark terminals.
      if (!top && !bottom) line += '\u2588';
      else if (!top && bottom) line += '\u2580';
      else if (top && !bottom) line += '\u2584';
      else line += ' ';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

function qrSvg(text, scale = 6) {
  const m = qrMatrix(text);
  const n = m.length;
  const q = 4;
  const size = (n + q * 2) * scale;
  let path = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (m[r][c]) path += 'M' + ((c + q) * scale) + ' ' + ((r + q) * scale) + 'h' + scale + 'v' + scale + 'h-' + scale + 'z';
    }
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size + '" width="' + size + '" height="' + size + '" shape-rendering="crispEdges">'
    + '<rect width="100%" height="100%" fill="#fff"/><path d="' + path + '" fill="#000"/></svg>';
}

// Lines printed when the server starts.
function startupLines(config, interfaces) {
  const lines = [];
  if (!config.lanExposed) {
    lines.push('[phone] Phone access is off (this PC only). To use your phone: run "npm run setup-phone", then "npm run open-firewall" as admin, then "npm start" again. See README "Connect your phone in 3 steps".');
    return { lines, qr: '' };
  }
  const links = phoneLinks(config, interfaces);
  if (!links.length) {
    lines.push('[phone] No home network address found. Connect this PC to Wi-Fi or Ethernet, then restart the server.');
    return { lines, qr: '' };
  }
  lines.push('');
  lines.push('=== Connect your phone ===');
  lines.push('On your phone (same Wi-Fi as this PC), open this link or scan the QR code below:');
  lines.push('  ' + links[0].url + '   (' + links[0].adapter + ')');
  for (const l of links.slice(1)) lines.push('  other address: ' + l.url + '   (' + l.adapter + ')');
  if (config.authToken) {
    lines.push('Note: this link contains your access token. Do not post it or share it publicly.');
  } else {
    lines.push('WARNING: no authToken is set, so anyone on your network can control this PC\'s YouTube. Run "npm run setup-phone" to add one.');
  }
  lines.push('You can also open http://127.0.0.1:' + config.port + '/ on this PC to see the same QR code.');
  return { lines, qr: qrTerminal(links[0].url) };
}

module.exports = { isPrivateIPv4, lanAddresses, phoneLinks, phoneUrl, qrMatrix, qrTerminal, qrSvg, startupLines };
