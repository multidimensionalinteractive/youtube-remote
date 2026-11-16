// YouTube Remote queue logic. Pure functions, no DOM.
// Loaded by the extension before content.js (window.YTRemoteQueue) and by the
// server / tests through require().
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.YTRemoteQueue = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_ITEMS = 200;
  const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

  function cleanText(value, max) {
    return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function isVideoId(id) {
    return typeof id === 'string' && VIDEO_ID.test(id);
  }

  function makeUid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // Accepts { id | videoId, title, channel, uid? }. Returns a clean item or null.
  function sanitizeItem(raw, uidFactory = makeUid) {
    if (!raw || typeof raw !== 'object') return null;
    const id = String(raw.id || raw.videoId || '');
    if (!isVideoId(id)) return null;
    const uid = typeof raw.uid === 'string' && /^[a-z0-9]{4,32}$/i.test(raw.uid) ? raw.uid : uidFactory();
    return {
      uid,
      id,
      title: cleanText(raw.title, 200) || 'YouTube video',
      channel: cleanText(raw.channel, 120),
    };
  }

  function sanitizeList(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    const seen = new Set();
    for (const raw of list) {
      const item = sanitizeItem(raw);
      if (!item || seen.has(item.uid)) continue;
      seen.add(item.uid);
      out.push(item);
      if (out.length >= MAX_ITEMS) break;
    }
    return out;
  }

  // next=true puts it first ("Play next"), otherwise last ("Add to queue").
  function add(list, raw, { next = false, uidFactory } = {}) {
    const item = sanitizeItem({ ...(raw || {}), uid: undefined }, uidFactory);
    if (!item) throw new Error('A valid YouTube video id is required');
    const copy = list.slice();
    if (copy.length >= MAX_ITEMS) throw new Error('The queue is full (' + MAX_ITEMS + ' videos)');
    if (next) copy.unshift(item);
    else copy.push(item);
    return { list: copy, item };
  }

  function indexOfUid(list, uid) {
    return list.findIndex((i) => i.uid === uid);
  }

  function remove(list, uid) {
    const i = indexOfUid(list, uid);
    if (i < 0) return list.slice();
    const copy = list.slice();
    copy.splice(i, 1);
    return copy;
  }

  // Moves the item to position `to` (0 based, clamped).
  function move(list, uid, to) {
    const from = indexOfUid(list, uid);
    if (from < 0) return list.slice();
    const copy = list.slice();
    const [item] = copy.splice(from, 1);
    let target = Math.round(Number(to));
    if (!Number.isFinite(target)) target = from;
    target = Math.max(0, Math.min(copy.length, target));
    copy.splice(target, 0, item);
    return copy;
  }

  // Takes an item out of the queue to play it. Without uid, takes the first one.
  function take(list, uid) {
    const i = uid ? indexOfUid(list, uid) : 0;
    if (i < 0 || !list.length) return { list: list.slice(), item: null };
    const copy = list.slice();
    const [item] = copy.splice(i, 1);
    return { list: copy, item };
  }

  // Should the extension start the next queued video now?
  function shouldAdvance({ queueLength, stopAfter, adPlaying, duration, currentTime, ended, alreadyAdvancing }) {
    if (!queueLength || stopAfter || adPlaying || alreadyAdvancing) return false;
    if (ended) return true;
    if (!Number.isFinite(duration) || duration < 2) return false;
    return (duration - currentTime) <= 0.6;
  }

  return { MAX_ITEMS, isVideoId, cleanText, sanitizeItem, sanitizeList, add, remove, move, take, shouldAdvance, indexOfUid };
});
