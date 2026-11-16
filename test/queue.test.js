'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Q = require('../extension/queue-core');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
let n = 0;
const uid = () => 'u' + (++n).toString().padStart(4, '0');
const A = { id: 'aaaaaaaaaaa', title: 'A', channel: 'ch' };
const B = { id: 'bbbbbbbbbbb', title: 'B' };
const C = { id: 'ccccccccccc', title: 'C' };

function build() {
  let list = [];
  ({ list } = Q.add(list, A, { uidFactory: uid }));
  ({ list } = Q.add(list, B, { uidFactory: uid }));
  ({ list } = Q.add(list, C, { uidFactory: uid }));
  return list;
}

describe('queue core', () => {
  it('Add to queue appends, Play next puts it first', () => {
    let list = build();
    assert.deepEqual(list.map((i) => i.title), ['A', 'B', 'C']);
    ({ list } = Q.add(list, { id: 'ddddddddddd', title: 'D' }, { next: true }));
    assert.deepEqual(list.map((i) => i.title), ['D', 'A', 'B', 'C']);
  });

  it('rejects bad video ids and cleans titles', () => {
    assert.throws(() => Q.add([], { id: 'nope' }));
    assert.throws(() => Q.add([], { id: 'aaaaaaaaaaa"><x' }));
    const { item } = Q.add([], { id: 'aaaaaaaaaaa', title: '  a\n\tb  ' + 'x'.repeat(500) });
    assert.equal(item.title.slice(0, 4), 'a b ');
    assert.ok(item.title.length <= 200);
    assert.equal(Q.add([], { videoId: 'aaaaaaaaaaa' }).item.title, 'YouTube video');
  });

  it('removes, moves (clamped), and takes by uid or from the front', () => {
    const list = build();
    const [a, b, c] = list;
    assert.deepEqual(Q.remove(list, b.uid).map((i) => i.title), ['A', 'C']);
    assert.deepEqual(Q.remove(list, 'missing').map((i) => i.title), ['A', 'B', 'C']);
    assert.deepEqual(Q.move(list, a.uid, 2).map((i) => i.title), ['B', 'C', 'A']);
    assert.deepEqual(Q.move(list, c.uid, 0).map((i) => i.title), ['C', 'A', 'B']);
    assert.deepEqual(Q.move(list, a.uid, 99).map((i) => i.title), ['B', 'C', 'A']);
    assert.deepEqual(Q.move(list, c.uid, -5).map((i) => i.title), ['C', 'A', 'B']);
    const t1 = Q.take(list);
    assert.equal(t1.item.title, 'A');
    assert.deepEqual(t1.list.map((i) => i.title), ['B', 'C']);
    const t2 = Q.take(list, c.uid);
    assert.equal(t2.item.title, 'C');
    assert.equal(Q.take([], null).item, null);
    assert.deepEqual(list.map((i) => i.title), ['A', 'B', 'C'], 'inputs are not mutated');
  });

  it('caps the queue size and drops junk when loading', () => {
    let list = [];
    for (let i = 0; i < Q.MAX_ITEMS; i++) list.push({ uid: 'x' + i.toString().padStart(4, '0'), id: 'aaaaaaaaaaa', title: 't' });
    assert.throws(() => Q.add(Q.sanitizeList(list), A), /full/);
    assert.deepEqual(Q.sanitizeList('nope'), []);
    assert.equal(Q.sanitizeList([null, { id: 'bad' }, { uid: 'abcd', id: 'aaaaaaaaaaa' }, { uid: 'abcd', id: 'bbbbbbbbbbb' }]).length, 1);
  });

  it('advances only at the very end, never during ads or with Stop after on', () => {
    const base = { queueLength: 2, stopAfter: false, adPlaying: false, duration: 200, currentTime: 199.5, ended: false, alreadyAdvancing: false };
    assert.equal(Q.shouldAdvance(base), true);
    assert.equal(Q.shouldAdvance({ ...base, currentTime: 150 }), false);
    assert.equal(Q.shouldAdvance({ ...base, stopAfter: true }), false);
    assert.equal(Q.shouldAdvance({ ...base, stopAfter: true, ended: true }), false);
    assert.equal(Q.shouldAdvance({ ...base, adPlaying: true }), false);
    assert.equal(Q.shouldAdvance({ ...base, queueLength: 0 }), false);
    assert.equal(Q.shouldAdvance({ ...base, alreadyAdvancing: true }), false);
    assert.equal(Q.shouldAdvance({ ...base, currentTime: 0, duration: NaN, ended: true }), true);
  });
});

describe('queue wiring', () => {
  const content = read('extension/content.js');
  const server = read('server.js');
  const ui = read('public/index.html');
  const manifest = JSON.parse(read('extension/manifest.json'));

  it('extension loads queue-core before content.js', () => {
    assert.deepEqual(manifest.content_scripts[0].js, ['queue-core.js', 'content.js']);
  });

  it('content script handles every queue action and reports the queue in status', () => {
    for (const a of ['queueAdd', 'queueRemove', 'queueMove', 'queueClear', 'queuePlay', 'ytQueuePlay']) {
      assert.match(content, new RegExp("case '" + a + "'"));
    }
    assert.match(content, /\.\.\.queueStatus\(\)/);
    assert.match(content, /stopAfter: !!stopAfter,\n      adPlaying: isAdPlaying\(\)/);
    assert.match(content, /if \(loadQueue\(\)\.length\) \{ playQueueItem\(null\); return getStatus\(\); \}/);
    assert.match(content, /v\.addEventListener\('ended', onQueueEnded\)/);
    assert.match(content, /ytd-playlist-panel-video-renderer/);
    assert.match(content, /\.ytp-next-button/);
  });

  it('server allowlists queue actions and forwards only sanitized fields', () => {
    for (const a of ['queueAdd', 'queueRemove', 'queueMove', 'queueClear', 'queuePlay', 'ytQueuePlay']) {
      assert.match(server, new RegExp("'" + a + "'"));
    }
    assert.match(server, /payload = sanitizeQueueCommand\(action, body\)/);
  });

  it('UI has the queue card, search actions, drag handle, and up/down/remove', () => {
    assert.match(ui, /id="queueCard"/);
    assert.match(ui, /id="queueClear"/);
    assert.match(ui, /'Play next'/);
    assert.match(ui, /'Add to queue'/);
    assert.match(ui, /\.qhandle \{[^}]*touch-action: none/);
    assert.match(ui, /addEventListener\('pointerdown'/);
    assert.match(ui, /'Move up'/);
    assert.match(ui, /'Move down'/);
    assert.match(ui, /'Remove from queue'/);
    assert.match(ui, /queueCommand\('ytQueuePlay'/);
    assert.doesNotMatch(ui.slice(ui.indexOf('function queueRow'), ui.indexOf('function renderQueue')), /innerHTML = [^']*item\./, 'titles go in with textContent');
  });
});

describe('server sanitizeQueueCommand', () => {
  // Load the function without starting the server.
  const src = read('server.js');
  const start = src.indexOf('function sanitizeQueueCommand');
  const end = src.indexOf('\n}\n', start) + 2;
  const fn = new Function('queueCore', src.slice(start, end) + '\nreturn sanitizeQueueCommand;')(Q);

  it('drops unknown fields and validates input', () => {
    assert.deepEqual(fn('queueAdd', { video: { id: 'aaaaaaaaaaa', title: 'T', extra: 1 }, token: 'secret', next: true }),
      { action: 'queueAdd', next: true, video: { id: 'aaaaaaaaaaa', title: 'T', channel: '' } });
    assert.throws(() => fn('queueAdd', { video: { id: 'x' } }));
    assert.deepEqual(fn('queueMove', { uid: 'abcd1234', to: 3 }), { action: 'queueMove', uid: 'abcd1234', to: 3 });
    assert.throws(() => fn('queueMove', { uid: 'abcd1234', to: -1 }));
    assert.throws(() => fn('queueRemove', { uid: '../x' }));
    assert.deepEqual(fn('ytQueuePlay', { videoId: 'aaaaaaaaaaa', index: 4 }), { action: 'ytQueuePlay', videoId: 'aaaaaaaaaaa', index: 4 });
    assert.deepEqual(fn('queueClear', { anything: 1 }), { action: 'queueClear' });
  });
});
