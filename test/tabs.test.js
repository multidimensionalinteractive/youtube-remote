'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { createTabRegistry, isTabKey } = require('../lib/tabs');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

function clock(start = 1000) {
  let t = start;
  const now = () => t;
  now.add = (ms) => { t += ms; };
  return now;
}
const sock = (name) => ({ name });
const st = (title, paused, extra = {}) => ({ title, paused, videoId: 'aaaaaaaaaaa', ...extra });

describe('tab registry: selection', () => {
  it('validates tab keys', () => {
    assert.equal(isTabKey('t123'), true);
    assert.equal(isTabKey('s_ab-9'), true);
    assert.equal(isTabKey(''), false);
    assert.equal(isTabKey('a b'), false);
    assert.equal(isTabKey('x'.repeat(41)), false);
    assert.equal(isTabKey(42), false);
    assert.throws(() => createTabRegistry().connect('../x', sock('a')));
  });

  it('auto-selects the only tab, then follows a playing tab', () => {
    const now = clock();
    const r = createTabRegistry({ now });
    r.connect('t1', sock('a'));
    r.update('t1', st('One', true));
    r.resolve();
    assert.equal(r.selectedKey, 't1');
    now.add(10);
    r.connect('t2', sock('b'));
    r.update('t2', st('Two', false));
    r.resolve();
    assert.equal(r.selectedKey, 't2', 'paused tab gives way to a playing one');
  });

  it('auto mode does not flip away from a playing tab', () => {
    const now = clock();
    const r = createTabRegistry({ now });
    r.connect('t1', sock('a')); r.update('t1', st('One', false)); r.resolve();
    now.add(10);
    r.connect('t2', sock('b')); r.update('t2', st('Two', false)); r.resolve();
    assert.equal(r.selectedKey, 't1');
    for (let i = 0; i < 5; i += 1) { now.add(1500); r.update('t2', st('Two', false)); r.update('t1', st('One', false)); r.resolve(); }
    assert.equal(r.selectedKey, 't1', 'no cycling between two playing tabs');
  });

  it('a picked (pinned) tab ignores status updates from other tabs', () => {
    const now = clock();
    const r = createTabRegistry({ now });
    r.connect('t1', sock('a')); r.connect('t2', sock('b')); r.connect('t3', sock('c'));
    r.select('t2');
    for (let i = 0; i < 10; i += 1) {
      now.add(700);
      r.update('t1', st('One', false));
      r.update('t3', st('Three', false));
      r.update('t2', st('Two', true));
      r.resolve();
      assert.equal(r.selectedKey, 't2');
    }
    assert.equal(r.snapshot().pinned, true);
  });

  it('keeps the pinned tab through a quick reconnect', () => {
    const now = clock();
    const r = createTabRegistry({ now, graceMs: 8000 });
    const a = sock('a');
    r.connect('t1', a); r.connect('t2', sock('b'));
    r.update('t2', st('Two', false));
    r.select('t1');
    r.disconnect('t1', a);
    now.add(2000); r.resolve();
    assert.equal(r.selectedKey, 't1', 'still selected while reconnecting');
    assert.equal(r.selectedSocket(), null);
    const a2 = sock('a2');
    r.connect('t1', a2); r.resolve();
    assert.equal(r.selectedKey, 't1');
    assert.equal(r.selectedSocket(), a2);
  });

  it('falls back to a playing tab when the picked tab closes, and says so', () => {
    const now = clock();
    const r = createTabRegistry({ now, graceMs: 8000 });
    const a = sock('a');
    r.connect('t1', a); r.update('t1', st('Picked', true));
    now.add(5); r.connect('t2', sock('b')); r.update('t2', st('Paused one', true));
    now.add(5); r.connect('t3', sock('c')); r.update('t3', st('Music', false));
    r.select('t1');
    r.disconnect('t1', a);
    now.add(9000); r.resolve();
    assert.equal(r.selectedKey, 't3');
    assert.equal(r.pinnedKey, null);
    const snap = r.snapshot();
    assert.equal(snap.pinned, false);
    assert.match(snap.notice, /closed\. Now controlling: Music/);
    assert.deepEqual(snap.tabs.map((t) => t.key), ['t2', 't3']);
  });

  it('falls back to the most recently used tab when nothing is playing', () => {
    const now = clock();
    const r = createTabRegistry({ now, graceMs: 1000 });
    const a = sock('a');
    r.connect('t1', a);
    now.add(10); r.connect('t2', sock('b')); r.update('t2', st('Old', true));
    now.add(10); r.connect('t3', sock('c')); r.update('t3', st('Recent', true, { tab: { focused: true } }));
    r.select('t1');
    r.disconnect('t1', a);
    now.add(2000); r.resolve();
    assert.equal(r.selectedKey, 't3');
  });

  it('a pin restored from disk waits for its tab, then takes over', () => {
    const now = clock();
    const r = createTabRegistry({ now, graceMs: 8000, pinned: 't9' });
    r.connect('t1', sock('a')); r.update('t1', st('Other', false));
    r.resolve();
    assert.equal(r.selectedKey, 't1', 'something is controllable meanwhile');
    now.add(1000);
    r.connect('t9', sock('z')); r.resolve();
    assert.equal(r.selectedKey, 't9');
  });

  it('a stale pin from disk is dropped after the grace period', () => {
    const now = clock();
    const r = createTabRegistry({ now, graceMs: 8000, pinned: 't9' });
    r.connect('t1', sock('a'));
    now.add(9000); r.resolve();
    assert.equal(r.pinnedKey, null);
    assert.equal(r.selectedKey, 't1');
  });

  it('select("auto") unpins; selecting a closed tab throws', () => {
    const r = createTabRegistry();
    r.connect('t1', sock('a')); r.connect('t2', sock('b'));
    r.select('t2');
    assert.equal(r.select('auto'), r.selectedKey);
    assert.equal(r.pinnedKey, null);
    assert.throws(() => r.select('t77'), /no longer open/);
  });

  it('a newer socket for the same tab replaces the old one', () => {
    const r = createTabRegistry();
    const a = sock('a'); const b = sock('b');
    r.connect('t1', a);
    assert.equal(r.connect('t1', b).replaced, a);
    assert.equal(r.disconnect('t1', a), false, 'late close of the old socket is ignored');
    assert.equal(r.connectedCount(), 1);
  });

  it('list is sanitized and sorted by window then tab position', () => {
    const r = createTabRegistry();
    r.connect('t1', sock('a')); r.update('t1', { title: 'B\u0000<b>x</b>', paused: false, videoId: 'bad', tab: { windowId: 2, index: 0 } });
    r.connect('t2', sock('b')); r.update('t2', { title: 'A', paused: true, videoId: 'ccccccccccc', tab: { windowId: 1, index: 3 } });
    r.resolve();
    const s = r.snapshot();
    assert.deepEqual(s.tabs.map((t) => t.key), ['t2', 't1']);
    assert.equal(s.tabs[1].title, 'B <b>x</b>', 'control chars removed; UI renders as text');
    assert.equal(s.tabs[1].videoId, null);
    assert.equal(s.windowCount, 2);
    assert.equal(typeof r.signature(), 'string');
  });
});

describe('tab picker wiring', () => {
  const content = read('extension/content.js');
  const background = read('extension/background.js');
  const html = read('public/index.html');
  const server = read('server.js');

  it('content script tags its socket with its tab and obeys control messages', () => {
    assert.match(content, /BRIDGE_URL \+ '&tab=' \+ encodeURIComponent\(tabKey\)/);
    assert.match(content, /msg\.type === 'control'/);
    assert.match(content, /ev\.code === 4000/);
    assert.match(content, /function maybeAdvanceQueue\(ended\) \{\n    if \(!controlled\) return;/);
    assert.match(content, /function enforceStopAtEnd\(\) \{\n    if \(!stopAfter \|\| !controlled\) return;/);
    assert.doesNotMatch(content, /\['load','play','togglePlay'\]\.includes\(action\)\) \{\n\s*const cleanup/, 'Play must not close other tabs');
  });
  it('background answers whoAmI with the tab id', () => {
    assert.match(background, /msg\.action !== 'whoAmI'/);
    assert.match(background, /tabId: sender\.tab\.id/);
  });
  it('server keeps every tab and no longer evicts the previous bridge', () => {
    assert.doesNotMatch(server, /bridgeSocket/);
    assert.match(server, /attachBridgeTab\(socket, url\)/);
    assert.match(server, /'selectTab'/);
  });
  it('phone UI has the tab picker and renders titles as text', () => {
    assert.match(html, /id="btnTabs"/);
    assert.match(html, /id="tabsCard"/);
    assert.match(html, /function renderTabs\(snap\)/);
    assert.match(html, /title\.textContent = t\.title/);
    assert.match(html, /command\('selectTab'/);
  });
  it('selected tab file is git-ignored', () => {
    assert.match(read('.gitignore'), /^\.selected-tab\.json$/m);
  });
});

// End to end: real server, fake extension tabs over WebSocket.
describe('server with several tabs', () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const tabFile = path.join(os.tmpdir(), 'ytr-tab-test-' + process.pid + '.json');
  let child;
  const base = 'http://127.0.0.1:' + port;

  function fakeTab(key, status) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket('ws://127.0.0.1:' + port + '/?role=bridge&tab=' + key);
      const tab = { ws, key, controlled: null, received: [], status };
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.type === 'control') { tab.controlled = msg.controlled; return; }
        if (msg.id != null) {
          tab.received.push(msg.action);
          ws.send(JSON.stringify({ id: msg.id, result: { status: { ...tab.status, lastAction: msg.action } } }));
        }
      });
      ws.on('open', () => { ws.send(JSON.stringify({ type: 'status', status })); resolve(tab); });
      ws.on('error', reject);
    });
  }
  const post = (body) => fetch(base + '/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ code: r.status, data: await r.json() }));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  before(async () => {
    child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, YT_REMOTE_PORT: String(port), YT_REMOTE_HOST: '127.0.0.1', YT_REMOTE_SELECTED_TAB_FILE: tabFile }, stdio: 'ignore' });
    for (let i = 0; i < 50; i += 1) {
      try { if ((await fetch(base + '/api/health')).ok) return; } catch (_) {}
      await wait(100);
    }
    throw new Error('server did not start');
  });
  after(() => { if (child) child.kill(); try { fs.unlinkSync(tabFile); } catch (_) {} });

  it('routes commands only to the picked tab, without evicting the others', async () => {
    const a = await fakeTab('t101', st('Alpha', false));
    const b = await fakeTab('t102', st('Bravo', false));
    const c = await fakeTab('t103', st('Charlie', true));
    await wait(300);
    let s = await (await fetch(base + '/api/status')).json();
    assert.equal(s.tabs.tabs.length, 3, 'all three tabs listed');
    assert.equal(a.ws.readyState, WebSocket.OPEN);
    assert.equal(b.ws.readyState, WebSocket.OPEN);

    let r = await post({ action: 'selectTab', tab: 't102' });
    assert.equal(r.code, 200);
    assert.equal(r.data.result.tabs.selected, 't102');
    assert.equal(r.data.result.tabs.pinned, true);
    await wait(100);
    assert.equal(b.controlled, true);
    assert.equal(a.controlled, false);
    assert.equal(c.controlled, false);
    assert.deepEqual(JSON.parse(fs.readFileSync(tabFile, 'utf8')), { tab: 't102' });

    // Other tabs keep reporting; the selection must not move.
    for (let i = 0; i < 4; i += 1) {
      a.ws.send(JSON.stringify({ type: 'status', status: st('Alpha', false) }));
      c.ws.send(JSON.stringify({ type: 'status', status: st('Charlie', false) }));
      await wait(50);
    }
    r = await post({ action: 'pause' });
    assert.equal(r.code, 200);
    assert.equal(r.data.result.status.title, 'Bravo');
    assert.deepEqual(b.received.filter((x) => x === 'pause'), ['pause']);
    const others = [...a.received, ...c.received].filter((x) => x !== 'status');
    assert.deepEqual(others, [], 'other tabs got no commands');

    // Picked tab reloads: it reconnects with the same id and stays in control.
    b.ws.close();
    await wait(150);
    const b2 = await fakeTab('t102', st('Bravo again', true));
    await wait(150);
    r = await post({ action: 'play' });
    assert.equal(r.code, 200);
    assert.equal(r.data.result.status.title, 'Bravo again');
    assert.equal(b2.controlled, true);

    // Auto: follows the playing tab and clears the saved pick.
    r = await post({ action: 'selectTab', tab: 'auto' });
    assert.equal(r.code, 200);
    assert.equal(r.data.result.tabs.pinned, false);
    assert.equal(fs.existsSync(tabFile), false);
    assert.ok(['t101', 't103'].includes(r.data.result.tabs.selected), 'a playing tab is chosen');

    // Closing the controlled tab moves control after the grace period (unit-tested above);
    // closing a non-controlled tab just removes it from the list later.
    for (const t of [a, b2, c]) t.ws.close();
  });

  it('rejects an invalid tab id', async () => {
    const r = await post({ action: 'selectTab', tab: '<script>' });
    assert.equal(r.code, 400);
    assert.match(r.data.error, /Unknown tab/);
  });
});
