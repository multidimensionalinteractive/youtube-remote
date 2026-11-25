'use strict';

// Tracks every open YouTube tab that has the extension's bridge connected and
// decides which one the remote controls. Pure logic (no sockets, no timers of
// its own) so it is easy to test.
//
// Rules:
// - A tab you pick on the phone is "pinned". Status updates from other tabs
//   never change the selection while the pinned tab is open.
// - A tab that disconnects (page reload, queue jump, YouTube navigation) is
//   kept for a short grace period so a quick reconnect does not switch tabs.
// - If the pinned tab is gone for longer than that, the pin is dropped and the
//   remote falls back to a playing tab, otherwise the most recently used one.
// - With no pin ("Auto"), the remote follows a playing tab and only moves off
//   the current tab when it is not playing and another tab is.

const GRACE_MS = 8000;
const MAX_TABS = 50;

function isTabKey(key) {
  return typeof key === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(key);
}

function cleanText(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
}

function isVideoId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id);
}

function num(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x : 0;
}

function intOrNull(n) {
  return Number.isInteger(n) ? n : null;
}

function createTabRegistry(options = {}) {
  const now = options.now || Date.now;
  const graceMs = options.graceMs == null ? GRACE_MS : options.graceMs;
  const startedAt = now();
  const tabs = new Map();
  let selectedKey = null;
  let pinnedKey = isTabKey(options.pinned) ? options.pinned : null;
  let notice = null; // { text, at }

  function entry(key) { return tabs.get(key) || null; }
  function isAlive(t) { return !!t && (t.socket != null || now() - t.goneAt < graceMs); }
  function isPlaying(t) { return !!(t && t.status && t.status.paused === false); }

  function connect(key, socket, info = {}) {
    if (!isTabKey(key)) throw new Error('invalid tab key');
    let t = entry(key);
    let replaced = null;
    if (t) {
      if (t.socket && t.socket !== socket) replaced = t.socket;
    } else {
      if (tabs.size >= MAX_TABS) throw new Error('too many tabs');
      t = { key, status: null, connectedAt: now(), lastActiveAt: now(), lastPlayingAt: 0, info: {} };
      tabs.set(key, t);
    }
    t.socket = socket;
    t.goneAt = 0;
    t.connectedAt = t.connectedAt || now();
    setInfo(t, info);
    return { replaced };
  }

  function disconnect(key, socket) {
    const t = entry(key);
    if (!t || t.socket !== socket) return false;
    t.socket = null;
    t.goneAt = now();
    return true;
  }

  function setInfo(t, info) {
    if (!info || typeof info !== 'object') return;
    const out = t.info;
    if (info.windowId !== undefined) out.windowId = intOrNull(info.windowId);
    if (info.index !== undefined) out.index = intOrNull(info.index);
    if (info.visible !== undefined) out.visible = !!info.visible;
    if (info.focused !== undefined) out.focused = !!info.focused;
    if (out.focused || out.visible) t.lastActiveAt = Math.max(t.lastActiveAt, now() - (out.focused ? 0 : 1));
  }

  function update(key, status) {
    const t = entry(key);
    if (!t || !status || typeof status !== 'object') return false;
    t.status = status;
    if (status.paused === false) { t.lastPlayingAt = now(); t.lastActiveAt = now(); }
    if (status.tab && typeof status.tab === 'object') setInfo(t, status.tab);
    return true;
  }

  function pick() {
    const alive = [...tabs.values()].filter(isAlive);
    const connected = alive.filter((t) => t.socket != null);
    const playing = connected.filter(isPlaying).sort((a, b) => b.lastPlayingAt - a.lastPlayingAt);
    if (playing.length) return playing[0].key;
    const recent = (connected.length ? connected : alive).sort((a, b) => b.lastActiveAt - a.lastActiveAt || b.connectedAt - a.connectedAt);
    return recent.length ? recent[0].key : null;
  }

  function label(t) {
    const title = t && t.status && cleanText(t.status.title, 80);
    return title || 'another YouTube tab';
  }

  // Recompute the selection. Returns true when the controlled tab changed.
  function resolve() {
    const before = selectedKey;
    // Forget tabs that have been gone longer than the grace period.
    for (const [key, t] of tabs) {
      if (!isAlive(t)) tabs.delete(key);
    }
    if (pinnedKey) {
      const p = entry(pinnedKey);
      if (p && isAlive(p)) {
        selectedKey = pinnedKey;
      } else if (!p && now() - startedAt < graceMs) {
        // Restored pin from disk: the tab may still be reconnecting after a server
        // restart, so use the best other tab for now and switch back when it returns.
        selectedKey = pick();
      } else {
        pinnedKey = null;
        selectedKey = pick();
        const s = entry(selectedKey);
        notice = { text: s ? 'The tab you picked was closed. Now controlling: ' + label(s) : 'The tab you picked was closed.', at: now() };
      }
    }
    if (!pinnedKey) {
      const cur = entry(selectedKey);
      if (cur && isAlive(cur)) {
        const otherPlaying = [...tabs.values()].some((t) => t !== cur && t.socket != null && isPlaying(t));
        // Stay on the current tab (even while it briefly reconnects) unless it is
        // not playing and another tab is.
        if (!isPlaying(cur) && otherPlaying) selectedKey = pick();
      } else {
        const lost = cur == null && before != null;
        selectedKey = pick();
        if (lost && selectedKey && selectedKey !== before) {
          notice = { text: 'The tab you were controlling closed. Now controlling: ' + label(entry(selectedKey)), at: now() };
        }
      }
    }
    return before !== selectedKey;
  }

  function select(key) {
    if (key == null || key === '' || key === 'auto') {
      pinnedKey = null;
      notice = null;
      resolve();
      return selectedKey;
    }
    const t = entry(key);
    if (!t || !isAlive(t)) throw new Error('That tab is no longer open');
    pinnedKey = key;
    selectedKey = key;
    t.lastActiveAt = now();
    notice = null;
    return selectedKey;
  }

  function selected() { return entry(selectedKey); }
  function selectedSocket() { const t = selected(); return t ? t.socket : null; }
  function connectedCount() { let n = 0; for (const t of tabs.values()) if (t.socket != null) n += 1; return n; }
  function sockets() { return [...tabs.values()].filter((t) => t.socket != null).map((t) => ({ key: t.key, socket: t.socket })); }

  function list() {
    return [...tabs.values()]
      .filter(isAlive)
      .sort((a, b) => (num(a.info.windowId) - num(b.info.windowId)) || (num(a.info.index) - num(b.info.index)) || (a.connectedAt - b.connectedAt))
      .map((t) => {
        const s = t.status || {};
        return {
          key: t.key,
          title: cleanText(s.title, 200) || 'YouTube',
          channel: cleanText(s.channel, 120),
          videoId: isVideoId(s.videoId) ? s.videoId : null,
          paused: s.paused !== false,
          currentTime: num(s.currentTime),
          duration: num(s.duration),
          windowId: intOrNull(t.info.windowId),
          visible: !!t.info.visible,
          focused: !!t.info.focused,
          connected: t.socket != null,
          selected: t.key === selectedKey,
        };
      });
  }

  function snapshot() {
    const items = list();
    const windows = new Set(items.map((t) => t.windowId).filter((w) => w != null));
    return {
      selected: selectedKey,
      pinned: !!pinnedKey && pinnedKey === selectedKey,
      notice: notice && now() - notice.at < 60000 ? notice.text : null,
      windowCount: windows.size,
      tabs: items,
    };
  }

  // A compact fingerprint of what the phone shows (no playback position), so the
  // server only re-broadcasts the tab list when something visible changed.
  function signature() {
    const s = snapshot();
    return JSON.stringify([s.selected, s.pinned, s.notice, s.tabs.map((t) => [t.key, t.title, t.videoId, t.paused, t.windowId, t.connected, t.focused])]);
  }

  return {
    connect, disconnect, update, resolve, select, selected, selectedSocket,
    connectedCount, sockets, list, snapshot, signature,
    get selectedKey() { return selectedKey; },
    get pinnedKey() { return pinnedKey; },
    isControlled(key) { return key === selectedKey; },
  };
}

module.exports = { createTabRegistry, isTabKey, GRACE_MS, MAX_TABS };
