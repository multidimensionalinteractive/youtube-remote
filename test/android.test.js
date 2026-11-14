'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const ui = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'public/manifest.webmanifest'), 'utf8'));

function pngSize(file) {
  const buf = fs.readFileSync(path.join(root, 'public', file));
  assert.equal(buf.toString('ascii', 1, 4), 'PNG');
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

describe('web app manifest (Android install)', () => {
  it('has the required install fields', () => {
    assert.equal(manifest.name, 'YouTube Remote');
    assert.ok(manifest.short_name && manifest.short_name.length <= 12);
    assert.equal(manifest.start_url, '/');
    assert.equal(manifest.display, 'standalone');
    assert.match(manifest.theme_color, /^#[0-9a-f]{6}$/i);
    assert.match(manifest.background_color, /^#[0-9a-f]{6}$/i);
  });

  it('ships 192 and 512 icons, both any and maskable, with matching PNG sizes', () => {
    for (const purpose of ['any', 'maskable']) {
      for (const size of [192, 512]) {
        const icon = manifest.icons.find((i) => i.purpose === purpose && i.sizes === size + 'x' + size);
        assert.ok(icon, purpose + ' ' + size);
        assert.equal(icon.type, 'image/png');
        assert.deepEqual(pngSize(icon.src.replace(/^\//, '')), [size, size]);
      }
    }
  });

  it('is linked from the page and served with the manifest MIME type', () => {
    assert.match(ui, /<link rel="manifest" href="\/manifest\.webmanifest" \/>/);
    assert.match(server, /'\.webmanifest': 'application\/manifest\+json/);
  });
});

describe('Android Chrome page behavior', () => {
  it('has Android and iOS home screen meta tags', () => {
    assert.match(ui, /name="mobile-web-app-capable" content="yes"/);
    assert.match(ui, /name="apple-mobile-web-app-capable" content="yes"/);
    assert.match(ui, /name="theme-color"/);
    assert.match(ui, /rel="apple-touch-icon"/);
    assert.match(ui, /viewport-fit=cover/);
  });

  it('pads for all safe-area insets with fallbacks', () => {
    for (const side of ['top', 'right', 'bottom', 'left']) {
      assert.match(ui, new RegExp('env\\(safe-area-inset-' + side + ', 0px\\)'));
    }
  });

  it('has no hover-only styling outside a hover media query', () => {
    const css = ui.slice(ui.indexOf('<style>'), ui.indexOf('</style>'));
    const outside = css.replace(/@media \(hover: hover\) \{[^}]*\{[^}]*\}\s*\}/g, '');
    assert.doesNotMatch(outside, /:hover/);
  });

  it('handles cancelled touches on sliders and seeks on change', () => {
    assert.match(ui, /\$\('volume'\)\.addEventListener\('pointercancel'/);
    assert.match(ui, /\$\('seek'\)\.addEventListener\('pointercancel'/);
    assert.match(ui, /\$\('seek'\)\.addEventListener\('change'/);
    assert.doesNotMatch(ui, /\$\('seek'\)\.addEventListener\('pointerup'/);
    assert.match(ui, /touch-action: manipulation/);
  });
});

describe('reverse proxy trust (tailscale serve)', () => {
  it('does not give proxied loopback requests local trust', () => {
    assert.match(server, /function isLocalRequest\(req\)/);
    assert.match(server, /'x-forwarded-for'/);
    assert.match(server, /'tailscale-user-login'/);
    assert.doesNotMatch(server, /isLoopbackAddress\(req\.socket\.remoteAddress\)/);
  });
});
