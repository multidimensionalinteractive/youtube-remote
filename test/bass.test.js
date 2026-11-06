'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { BASS_DEFAULTS, clamp01, amountToDb, dbToAmount } = require('../lib/bass');

describe('bass math (public package)', () => {
  it('defaults are neutral with 200 Hz / 30 dB max cut', () => {
    assert.equal(BASS_DEFAULTS.frequencyHz, 200);
    assert.equal(BASS_DEFAULTS.maxCutDb, 30);
    assert.equal(BASS_DEFAULTS.defaultAmount, 0);
    assert.ok(BASS_DEFAULTS.frequencyHz >= 150 && BASS_DEFAULTS.frequencyHz <= 250);
  });

  it('amount 0 is neutral 0 dB', () => {
    assert.equal(amountToDb(0), 0);
    assert.equal(amountToDb(BASS_DEFAULTS.defaultAmount), 0);
  });

  it('amount 1 maps to -maxCutDb', () => {
    assert.equal(amountToDb(1), -30);
    assert.equal(amountToDb(1, 24), -24);
  });

  it('amount 0.4 maps to -12 dB with default max cut (live-verified mapping)', () => {
    assert.equal(amountToDb(0.4), -12);
  });

  it('clamps out-of-range amounts', () => {
    assert.equal(clamp01(-1), 0);
    assert.equal(clamp01(2), 1);
    assert.equal(amountToDb(99), -30);
    assert.equal(amountToDb(Number.NaN), 0);
  });

  it('dbToAmount round-trips typical values', () => {
    assert.equal(dbToAmount(0), 0);
    assert.equal(dbToAmount(-12), 0.4);
    assert.equal(dbToAmount(-30), 1);
  });
});

describe('extension content script bass wiring', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'extension', 'content.js'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'extension', 'manifest.json'), 'utf8'));

  it('uses MediaElementSource → lowshelf → destination chain', () => {
    assert.match(content, /createMediaElementSource/);
    assert.match(content, /createBiquadFilter/);
    assert.match(content, /type\s*=\s*['"]lowshelf['"]/);
    assert.match(content, /\.connect\(bassState\.ctx\.destination\)/);
    assert.match(content, /frequencyHz:\s*200/);
    assert.match(content, /maxCutDb:\s*30/);
  });

  it('preserves sources across video element replacement via WeakMap', () => {
    assert.match(content, /WeakMap/);
    assert.match(content, /__ytRemoteBassSources/);
    assert.match(content, /setInterval\(\s*\(\)\s*=>\s*\{\s*try\s*\{\s*ensureBassGraph/);
  });

  it('resumes AudioContext on play / visibility and persists amount', () => {
    assert.match(content, /sessionStorage/);
    assert.match(content, /resumeBassContext/);
    assert.match(content, /addEventListener\('play'/);
    assert.match(content, /visibilitychange/);
  });

  it('exposes bass fields on status like volume', () => {
    assert.match(content, /bass:\s*bassState\.amount/);
    assert.match(content, /bassDb:/);
    assert.match(content, /bassHz:/);
    assert.match(content, /bassMaxDb:/);
    assert.match(content, /case 'setBass'/);
    assert.match(content, /case 'bassBy'/);
  });

  it('does not pull remote CDNs or broaden host permissions', () => {
    assert.doesNotMatch(content, /cdn\.|unpkg|jsdelivr|googleapis/i);
    assert.deepEqual(manifest.permissions, ['tabs']);
    for (const p of manifest.host_permissions) {
      assert.ok(
        /youtube\.com|127\.0\.0\.1:8790|localhost:8790/.test(p),
        'unexpected host permission: ' + p
      );
    }
  });

  it('does not mutate element.volume inside setBass', () => {
    const setBassBlock = content.match(/function setBass\(amount\) \{[\s\S]*?\n  \}/);
    assert.ok(setBassBlock, 'setBass function present');
    assert.doesNotMatch(setBassBlock[0], /\.volume\s*=/);
  });
});

describe('mobile UI bass controls', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

  it('includes slider with − / + controls wired to setBass/bassBy', () => {
    assert.match(html, /id="bass"/);
    assert.match(html, /id="bassDown"/);
    assert.match(html, /id="bassUp"/);
    assert.match(html, /setBass/);
    assert.match(html, /bassBy/);
    assert.match(html, /bassMaxDb/);
  });
});
