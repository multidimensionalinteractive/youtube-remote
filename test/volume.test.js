'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  resolveStatusVolume,
  clampNewVideoElementVolume,
  postWrapElementAndGain,
  applyMediaSwap,
} = require('../lib/volume');
const { amountToDb } = require('../lib/bass');

describe('persistent GainNode loudness authority', () => {
  it('status volume follows GainNode, not element 100% or stale lastKnown', () => {
    const r = resolveStatusVolume({
      gainNodeValue: 0.3,
      elementVolume: 1,
      playerVolumeRaw: 100,
      lastKnownVolume: 0.35,
    });
    assert.equal(r.authority, 'gain');
    assert.equal(r.volume, 0.3);
    assert.equal(r.lastKnownVolume, 0.3);
  });

  it('setVolume .30 stays as gain .30 across repeated status polls (live-verified mapping)', () => {
    let gain = 0.3;
    for (let i = 0; i < 10; i++) {
      const r = resolveStatusVolume({
        gainNodeValue: gain,
        elementVolume: 1,
        playerVolumeRaw: 100,
        lastKnownVolume: 0.35,
      });
      assert.equal(r.volume, 0.3);
      gain = r.volume; // mirrors content.js writing lastKnown from gain
    }
  });

  it('restoring user volume .35 updates gain while bass cut stays independent', () => {
    const bassAmount = 0.75;
    assert.equal(amountToDb(bassAmount), -22.5);
    const wrapped = postWrapElementAndGain(0.35);
    assert.equal(wrapped.gainValue, 0.35);
    assert.equal(wrapped.elementVolume, 1);
    // Bass filter gain is separate from loudness GainNode.
    assert.equal(amountToDb(bassAmount), -22.5);
  });

  it('new <video> at default 1.0 is clamped immediately to desired loudness before wrap', () => {
    assert.equal(clampNewVideoElementVolume(1, 0.35), 0.35);
    assert.equal(clampNewVideoElementVolume(0.35, 0.35), 0.35);
  });

  it('media swap keeps persistent gain loudness (not a lying lastKnown-only filter)', () => {
    const swap = applyMediaSwap({
      previousGain: 0.3,
      desiredVolume: 0.3,
      newElementDefaultVolume: 1,
    });
    assert.equal(swap.preWrapElementVolume, 0.3);
    assert.equal(swap.elementVolume, 1);
    assert.equal(swap.gainValue, 0.3);
    assert.equal(swap.statusVolume, 0.3);
  });
});

describe('extension content.js GainNode chain wiring', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'extension', 'content.js'), 'utf8');

  it('builds source → lowshelf → gain → destination', () => {
    assert.match(content, /createMediaElementSource/);
    assert.match(content, /createBiquadFilter/);
    assert.match(content, /createGain/);
    assert.match(content, /filter\.connect\(bassState\.gain\)/);
    assert.match(content, /gain\.connect\(bassState\.ctx\.destination\)/);
    assert.match(content, /source\.connect\(bassState\.filter\)/);
  });

  it('clamps new videos, wraps on play + MutationObserver, and backs up every 500ms', () => {
    assert.match(content, /function clampAllVideoVolumes/);
    assert.match(content, /MutationObserver/);
    assert.match(content, /addEventListener\('play'/);
    assert.match(content, /setInterval\(\s*\(\)\s*=>\s*\{\s*try\s*\{\s*ensureBassGraph\(\);\s*\}\s*catch\s*\(_\)\s*\{\}\s*\},\s*500\)/);
  });

  it('reports GainNode value as status volume / gain fields', () => {
    assert.match(content, /volume = clamp01\(bassState\.gain\.gain\.value\)/);
    assert.match(content, /bassAttached:/);
    assert.match(content, /gain:\s*bassState\.gain \? bassState\.gain\.gain\.value/);
  });

  it('setVolume writes GainNode when graph is active and leaves element at 1', () => {
    const m = content.match(/function setVolume\(vol\) \{[\s\S]*?\n  \}/);
    assert.ok(m);
    assert.match(m[0], /bassState\.gain\.gain\.value\s*=\s*vol/);
    assert.match(m[0], /v\.volume\s*=\s*1/);
  });

  it('does not claim polluted-read filtering alone is the volume fix', () => {
    assert.doesNotMatch(content, /Do not let a one-off 100% reading poison lastKnownVolume/);
    assert.doesNotMatch(content, /Snapshot intentional volume BEFORE createMediaElementSource/);
  });
});

describe('mobile UI volume touch / suppress feedback', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

  it('ignores status volume updates while pointer/touch is active', () => {
    assert.match(html, /volumeTouching:\s*false/);
    assert.match(html, /suppressVolumeEvent:\s*false/);
    assert.match(html, /!state\.volumeTouching/);
    assert.match(html, /pointerdown[\s\S]*volumeTouching\s*=\s*true/);
    assert.match(html, /touchstart[\s\S]*volumeTouching\s*=\s*true/);
    assert.match(html, /if \(state\.suppressVolumeEvent\) return/);
  });
});
