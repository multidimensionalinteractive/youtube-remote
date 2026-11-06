'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  isAnomalousFullVolume,
  snapshotVolumeBeforeWrap,
  resolveStatusVolume,
} = require('../lib/volume');

describe('volume restore around createMediaElementSource', () => {
  it('treats sudden 100% as anomalous when last known was lower', () => {
    assert.equal(isAnomalousFullVolume(100, 0.4, { asPercent: true }), true);
    assert.equal(isAnomalousFullVolume(1, 0.4, { asPercent: false }), true);
    assert.equal(isAnomalousFullVolume(100, 1, { asPercent: true }), false);
    assert.equal(isAnomalousFullVolume(42, 0.4, { asPercent: true }), false);
  });

  it('snapshots player volume before wrap, ignoring poisoned 100% after prior wrap', () => {
    assert.equal(
      snapshotVolumeBeforeWrap({ lastKnownVolume: 0.4, playerVolumeRaw: 55, alreadyWrapped: false }),
      0.55
    );
    assert.equal(
      snapshotVolumeBeforeWrap({ lastKnownVolume: 0.4, playerVolumeRaw: 100, alreadyWrapped: true }),
      0.4
    );
    assert.equal(
      snapshotVolumeBeforeWrap({ lastKnownVolume: 0.4, playerVolumeRaw: 100, alreadyWrapped: false }),
      1
    );
  });

  it('while graph active, status volume stays on lastKnownVolume (not element 100%)', () => {
    const r = resolveStatusVolume({
      graphActive: true,
      lastKnownVolume: 0.4,
      elementVolume: 1,
      playerVolumeRaw: 100,
    });
    assert.equal(r.volume, 0.4);
    assert.equal(r.lastKnownVolume, 0.4);
  });

  it('without graph, accepts normal player readings and updates lastKnown', () => {
    const r = resolveStatusVolume({
      graphActive: false,
      lastKnownVolume: 0.4,
      elementVolume: 0.4,
      playerVolumeRaw: 55,
    });
    assert.equal(r.volume, 0.55);
    assert.equal(r.lastKnownVolume, 0.55);
  });

  it('without graph, ignores one-off anomalous 100% player reading', () => {
    const r = resolveStatusVolume({
      graphActive: false,
      lastKnownVolume: 0.4,
      elementVolume: 1,
      playerVolumeRaw: 100,
    });
    assert.equal(r.volume, 0.4);
    assert.equal(r.lastKnownVolume, 0.4);
  });
});

describe('extension content.js volume-restore wiring', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'extension', 'content.js'), 'utf8');

  it('declares lastKnownVolume and snapshots before createMediaElementSource', () => {
    assert.match(content, /let lastKnownVolume\s*=/);
    assert.match(content, /Snapshot intentional volume BEFORE createMediaElementSource/);
    assert.match(content, /createMediaElementSource\(v\)/);
    assert.match(content, /lastKnownVolume\s*=\s*clamp01\(snap\)/);
    assert.match(content, /p1\.setVolume\(Math\.round\(lastKnownVolume \* 100\)\)/);
    assert.match(content, /v\.volume\s*=\s*lastKnownVolume/);
  });

  it('uses lastKnownVolume while bass graph is attached', () => {
    assert.match(content, /if \(bassState\.source && bassState\.attachedVideo\)/);
    assert.match(content, /volume = lastKnownVolume/);
    assert.match(content, /Do not let a one-off 100% reading poison lastKnownVolume/);
  });

  it('setVolume updates lastKnownVolume before applying player/element volume', () => {
    const m = content.match(/function setVolume\(vol\) \{[\s\S]*?\n  \}/);
    assert.ok(m);
    assert.match(m[0], /lastKnownVolume\s*=\s*vol/);
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
