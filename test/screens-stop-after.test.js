'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const server = read('server.js');
const content = read('extension/content.js');
const ui = read('public/index.html');
const screensOff = read('scripts/screens-off.ps1');

describe('screens off', () => {
  it('is an allowlisted action routed to a fixed script via powershell -File', () => {
    assert.match(server, /'screensOff'/);
    assert.match(server, /if \(action === 'screensOff'\) return screensOff\(\);/);
    assert.match(server, /'-File', abs/);
    assert.match(server, /scripts', 'screens-off\.ps1'/);
  });

  it('sends SC_MONITORPOWER off (2) by PostMessage and SendMessage and re-asserts', () => {
    assert.match(screensOff, /SC_MONITORPOWER = 0xF170/);
    assert.match(screensOff, /\(IntPtr\)2/);
    assert.match(screensOff, /PostMessage\(broadcast/);
    assert.match(screensOff, /SendMessage\(broadcast/);
    assert.match(screensOff, /Shell_TrayWnd/);
    assert.match(screensOff, /for \(\$i = 0; \$i -lt 8; \$i\+\+\)/);
  });

  it('does not sleep, lock, or write log files', () => {
    assert.doesNotMatch(screensOff, /SetSuspendState|LockWorkStation|Add-Content|Out-File/i);
  });

  it('status polling never turns screens off or wakes them', () => {
    const statusBlock = server.match(/pathname === '\/api\/status'[\s\S]*?\n    \}\n/);
    assert.ok(statusBlock);
    assert.doesNotMatch(statusBlock[0], /screensOff|wakePC/);
  });

  it('has a Screens off button in the UI', () => {
    assert.match(ui, /id="btnScreensOff"/);
    assert.match(ui, /command\('screensOff'\)/);
  });
});

describe('stop after this video', () => {
  it('server allowlists the toggle actions', () => {
    assert.match(server, /'setStopAfter', 'toggleStopAfter'/);
  });

  it('content script handles toggle/set and reports stopAfter in status', () => {
    assert.match(content, /case 'toggleStopAfter'/);
    assert.match(content, /case 'setStopAfter'/);
    assert.match(content, /stopAfter: !!stopAfter/);
  });

  it('persists in chrome.storage.local and sessionStorage', () => {
    assert.match(content, /chrome\.storage\.local\.set\(\{ stopAfterThisVideo/);
    assert.match(content, /chrome\.storage\.local\.get\(\['stopAfterThisVideo'\]/);
    assert.match(content, /sessionStorage\.setItem\('ytRemoteStopAfter'/);
  });

  it('pauses about 1s before the end, skips ads, and cancels up next', () => {
    const block = content.match(/function enforceStopAtEnd\(\) \{[\s\S]*?\n  \}/);
    assert.ok(block);
    assert.match(block[0], /remaining > 1\.0\) return/);
    assert.match(block[0], /isAdPlaying\(\)/);
    assert.match(block[0], /cancelUpNext\(\)/);
    assert.match(content, /ytp-autonav-endscreen-upnext-cancel-button/);
  });

  it('UI button shows On/Off and turns green when on', () => {
    assert.match(ui, /id="btnStopAfter"/);
    assert.match(ui, /command\('toggleStopAfter'\)/);
    assert.match(ui, /classList\.toggle\('toggle-on'/);
    assert.match(ui, /button\.toggle-on \{/);
  });
});
