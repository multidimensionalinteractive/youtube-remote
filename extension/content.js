(function () {
  if (window.__ytRemoteContentLoaded) return;
  window.__ytRemoteContentLoaded = true;

  // Default matches server port 8790. If you change YT_REMOTE_PORT, update this URL and extension/manifest.json host_permissions.
  const BRIDGE_URL = 'ws://127.0.0.1:8790/?role=bridge';
  let socket = null;
  let reconnectTimer = null;
  let statusTimer = null;

  // Desired loudness (0–1). While the Web Audio graph is active, GainNode is the authority;
  // element/player volume reads after createMediaElementSource are not trustworthy.
  let lastKnownVolume = 0.75;

  // "Stop after this video": when on, pause about 1s before the end and cancel
  // autoplay / up next so YouTube never advances. Persisted in chrome.storage.local
  // (survives reloads) and mirrored in sessionStorage for instant reads on SPA navigation.
  let stopAfter = false;
  try {
    if (sessionStorage.getItem('ytRemoteStopAfter') === '1') stopAfter = true;
  } catch (_) {}
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(['stopAfterThisVideo'], (r) => {
        stopAfter = !!(r && r.stopAfterThisVideo);
        try { sessionStorage.setItem('ytRemoteStopAfter', stopAfter ? '1' : '0'); } catch (_) {}
        wireStopAfterHandlers();
      });
    }
  } catch (_) {}

  function videoEl() {
    return document.querySelector('video');
  }

  function player() {
    return document.getElementById('movie_player') || document.querySelector('.html5-video-player');
  }

  function getVideoId() {
    try {
      const u = new URL(location.href);
      if (u.pathname === '/watch') return u.searchParams.get('v');
      const shorts = u.pathname.match(/\/shorts\/([^/?]+)/);
      if (shorts) return shorts[1];
    } catch (_) {}
    return null;
  }

  function getTitle() {
    const t = document.querySelector('h1.ytd-watch-metadata yt-formatted-string, h1.title, h1');
    if (t && t.textContent) return t.textContent.trim();
    const raw = document.title || '';
    return raw.replace(/ - YouTube$/i, '').trim();
  }

  function getChannel() {
    const a = document.querySelector('#channel-name a, ytd-channel-name a, #owner #text a');
    return a && a.textContent ? a.textContent.trim() : '';
  }

  function isAdPlaying() {
    try {
      if (document.querySelector('.ad-showing, .ytp-ad-player-overlay, .ytp-ad-module')) return true;
    } catch (_) {}
    try {
      const p = player();
      if (p && typeof p.getAdState === 'function' && p.getAdState() === 1) return true;
    } catch (_) {}
    return false;
  }

  let stopAfterGuardUntil = 0;
  let stopAfterPinnedId = null;
  let stopAfterTimer = null;

  function disableAutoplayUi() {
    try {
      const toggles = document.querySelectorAll(
        '.ytp-autonav-toggle-button[aria-checked="true"],' +
        '.ytp-autonav-toggle-button[aria-pressed="true"],' +
        'button[aria-label*="Autoplay" i][aria-pressed="true"],' +
        'button[aria-label*="Autoplay" i][aria-checked="true"]'
      );
      toggles.forEach((b) => { try { b.click(); } catch (_) {} });
    } catch (_) {}
    try {
      const p = player();
      if (p && typeof p.setOption === 'function') {
        try { p.setOption('autonav', 'disabled'); } catch (_) {}
        try { p.setOption('autonav', false); } catch (_) {}
      }
      if (p && typeof p.setAutonav === 'function') {
        try { p.setAutonav(false); } catch (_) {}
      }
    } catch (_) {}
  }

  function cancelUpNext() {
    disableAutoplayUi();
    const sels = [
      '.ytp-autonav-endscreen-upnext-cancel-button',
      '.ytp-upnext-cancel-button',
      '.ytp-endscreen-content button[aria-label*="Cancel" i]',
      'button.ytp-upnext-cancel-button',
      'button[aria-label="Cancel"]',
      'button[aria-label*="Cancel autoplay" i]',
    ];
    for (const sel of sels) {
      document.querySelectorAll(sel).forEach((b) => { try { b.click(); } catch (_) {} });
    }
  }

  function pauseHard() {
    const v = videoEl();
    try { if (v) v.pause(); } catch (_) {}
    try {
      const p = player();
      if (p && typeof p.pauseVideo === 'function') p.pauseVideo();
    } catch (_) {}
  }

  function holdNearEnd(v) {
    if (!v || !isFinite(v.duration) || v.duration < 2) return;
    try {
      const target = Math.max(0, v.duration - 0.35);
      if (v.currentTime > target) v.currentTime = target;
    } catch (_) {}
  }

  function enforceStopAtEnd() {
    if (!stopAfter) return;
    if (isAdPlaying()) return;
    const v = videoEl();
    if (!v || !isFinite(v.duration) || v.duration < 2) return;
    const remaining = v.duration - v.currentTime;
    // Pause early so YouTube never reaches ENDED / autoplay handoff.
    if (remaining > 1.0) return;
    stopAfterGuardUntil = Date.now() + 8000;
    stopAfterPinnedId = getVideoId() || stopAfterPinnedId;
    pauseHard();
    holdNearEnd(v);
    cancelUpNext();
  }

  function onVideoEnded(ev) {
    if (!stopAfter) return;
    if (isAdPlaying()) return;
    const v = ev && ev.target ? ev.target : videoEl();
    stopAfterGuardUntil = Date.now() + 8000;
    stopAfterPinnedId = getVideoId() || stopAfterPinnedId;
    pauseHard();
    holdNearEnd(v);
    cancelUpNext();
    setTimeout(cancelUpNext, 150);
    setTimeout(cancelUpNext, 500);
    setTimeout(cancelUpNext, 1200);
    setTimeout(() => { pauseHard(); holdNearEnd(videoEl()); }, 200);
  }

  function onStopAfterPlay(ev) {
    if (!stopAfter) return;
    if (Date.now() > stopAfterGuardUntil) return;
    const t = ev && ev.target;
    if (!t || (t.tagName !== 'VIDEO' && t.tagName !== 'AUDIO')) return;
    // After we freeze near end, block YouTube restarting / advancing via play.
    if (isFinite(t.duration) && t.duration > 2 && (t.duration - t.currentTime) <= 1.5) {
      try { ev.preventDefault(); } catch (_) {}
      pauseHard();
      holdNearEnd(t);
      cancelUpNext();
    }
  }

  function wireStopAfterHandlers() {
    try {
      document.querySelectorAll('video').forEach((v) => {
        if (v.__ytRemoteStopWired) return;
        v.__ytRemoteStopWired = true;
        v.addEventListener('timeupdate', enforceStopAtEnd);
        v.addEventListener('ended', onVideoEnded);
        v.addEventListener('timeupdate', () => maybeAdvanceQueue(false));
        v.addEventListener('ended', onQueueEnded);
        v.addEventListener('seeking', enforceStopAtEnd);
        v.addEventListener('seeked', enforceStopAtEnd);
        v.addEventListener('ratechange', enforceStopAtEnd);
      });
    } catch (_) {}
    if (!window.__ytRemoteStopPlayHook) {
      window.__ytRemoteStopPlayHook = true;
      document.addEventListener('play', onStopAfterPlay, true);
    }
    if (!stopAfterTimer) {
      stopAfterTimer = setInterval(() => {
        try {
          maybeAdvanceQueue(false);
          if (!stopAfter) return;
          enforceStopAtEnd();
          if (Date.now() < stopAfterGuardUntil) cancelUpNext();
        } catch (_) {}
      }, 200);
    }
  }

  function setStopAfter(on) {
    stopAfter = !!on;
    try { sessionStorage.setItem('ytRemoteStopAfter', stopAfter ? '1' : '0'); } catch (_) {}
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ stopAfterThisVideo: stopAfter });
      }
    } catch (_) {}
    wireStopAfterHandlers();
    if (stopAfter) {
      stopAfterPinnedId = getVideoId();
      disableAutoplayUi();
      enforceStopAtEnd();
    } else {
      stopAfterGuardUntil = 0;
      stopAfterPinnedId = null;
    }
    return stopAfter;
  }

  // ---------------------------------------------------------------- Queue
  // The remote's own queue ("Up next"): videos added from the phone with
  // "Add to queue" / "Play next". It is saved in this site's localStorage so it
  // survives page loads, and it plays before YouTube's own autoplay / playlist.
  // "Stop after this video" wins: when it is on, the queue does not advance.
  const Q = window.YTRemoteQueue;
  const QUEUE_KEY = 'ytRemoteQueueV1';
  let queueAdvancingFor = null;
  let ytQueueCache = { at: 0, value: null };

  function loadQueue() {
    try { return Q.sanitizeList(JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]')); } catch (_) { return []; }
  }
  function saveQueue(list) {
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(Q.sanitizeList(list))); } catch (_) {}
    ytQueueCache.at = 0;
    setTimeout(() => { try { pushStatus(); } catch (_) {} }, 0);
  }

  function videoIdFromHref(href) {
    try {
      const u = new URL(href, location.origin);
      const v = u.searchParams.get('v');
      if (Q.isVideoId(v)) return v;
      const m = u.pathname.match(/\/shorts\/([A-Za-z0-9_-]{11})/);
      return m ? m[1] : null;
    } catch (_) { return null; }
  }

  function textOf(root, sels) {
    for (const s of sels) {
      const el = root.querySelector(s);
      const t = el && (el.getAttribute('title') || el.textContent);
      if (t && t.trim()) return Q.cleanText(t, 200);
    }
    return '';
  }

  // What YouTube itself will play next: the rest of a playlist / mix, or the
  // single autoplay "Up next" video. Read-only (YouTube does not expose edits).
  function readYouTubeQueue() {
    if (Date.now() - ytQueueCache.at < 1500 && ytQueueCache.value) return ytQueueCache.value;
    let value = { kind: null, items: [], playlistId: null };
    try {
      const u = new URL(location.href);
      const list = u.searchParams.get('list');
      const rows = Array.from(document.querySelectorAll('ytd-watch-flexy ytd-playlist-panel-renderer ytd-playlist-panel-video-renderer, ytd-playlist-panel-renderer#playlist ytd-playlist-panel-video-renderer'));
      const seenRows = new Set();
      const unique = rows.filter((r) => (seenRows.has(r) ? false : (seenRows.add(r), true)));
      if (list && unique.length) {
        let cur = unique.findIndex((r) => r.hasAttribute('selected'));
        const items = [];
        unique.forEach((r, index) => {
          if (index <= cur) return;
          const a = r.querySelector('a#wc-endpoint, a[href*="watch?v="]');
          const id = a && videoIdFromHref(a.getAttribute('href'));
          if (!id || items.length >= 25) return;
          items.push({ id, index, title: textOf(r, ['#video-title']), channel: textOf(r, ['#byline', '#channel-name']) });
        });
        value = { kind: 'playlist', items, playlistId: Q.cleanText(list, 64) };
      } else {
        let id = null;
        let title = '';
        const nextBtn = document.querySelector('.ytp-next-button');
        if (nextBtn && nextBtn.getAttribute('href')) {
          id = videoIdFromHref(nextBtn.getAttribute('href'));
          title = Q.cleanText(nextBtn.getAttribute('data-tooltip-text') || '', 200);
        }
        if (!id) {
          const first = document.querySelector('#secondary ytd-compact-video-renderer a[href*="watch?v="], #secondary yt-lockup-view-model a[href*="watch?v="]');
          if (first) {
            id = videoIdFromHref(first.getAttribute('href'));
            const card = first.closest('ytd-compact-video-renderer, yt-lockup-view-model') || first;
            title = title || textOf(card, ['#video-title', 'h3', 'a[title]']);
          }
        }
        if (id && id !== getVideoId()) value = { kind: 'autoplay', items: [{ id, index: null, title: title || 'Up next', channel: '' }], playlistId: null };
      }
    } catch (_) {}
    ytQueueCache = { at: Date.now(), value };
    return value;
  }

  function goToVideo(id, extra = '') {
    queueAdvancingFor = getVideoId();
    location.href = 'https://www.youtube.com/watch?v=' + id + extra;
  }

  function playQueueItem(uid) {
    const { list, item } = Q.take(loadQueue(), uid);
    if (!item) return false;
    saveQueue(list);
    goToVideo(item.id);
    return true;
  }

  // Called on timeupdate, on ended, and every 200ms.
  function maybeAdvanceQueue(ended) {
    const v = videoEl();
    const queue = loadQueue();
    const go = Q.shouldAdvance({
      queueLength: queue.length,
      stopAfter: !!stopAfter,
      adPlaying: isAdPlaying(),
      duration: v ? v.duration : NaN,
      currentTime: v ? v.currentTime : 0,
      ended: !!ended || !!(v && v.ended),
      alreadyAdvancing: queueAdvancingFor !== null && queueAdvancingFor === getVideoId(),
    });
    if (!go) return;
    pauseHard();
    cancelUpNext();
    playQueueItem(null);
  }
  function onQueueEnded() { maybeAdvanceQueue(true); }

  function queueStatus() {
    return { queue: loadQueue(), ytQueue: readYouTubeQueue() };
  }

  function handleQueue(action, msg) {
    switch (action) {
      case 'queueAdd': {
        const { list } = Q.add(loadQueue(), msg.video, { next: !!msg.next });
        saveQueue(list);
        return true;
      }
      case 'queueRemove': saveQueue(Q.remove(loadQueue(), String(msg.uid || ''))); return true;
      case 'queueMove': saveQueue(Q.move(loadQueue(), String(msg.uid || ''), Number(msg.to))); return true;
      case 'queueClear': saveQueue([]); return true;
      case 'queuePlay':
        if (!playQueueItem(String(msg.uid || ''))) throw new Error('That video is no longer in the queue');
        return true;
      case 'ytQueuePlay': {
        const id = String(msg.videoId || '');
        if (!Q.isVideoId(id)) throw new Error('A valid YouTube video id is required');
        const yq = readYouTubeQueue();
        const p = player();
        if (yq.kind === 'playlist' && Number.isInteger(msg.index) && p && typeof p.playVideoAt === 'function') {
          p.playVideoAt(msg.index);
        } else if (yq.kind === 'playlist' && yq.playlistId) {
          goToVideo(id, '&list=' + encodeURIComponent(yq.playlistId));
        } else {
          goToVideo(id);
        }
        return true;
      }
      default:
        return false;
    }
  }
  window.addEventListener('storage', (e) => { if (e.key === QUEUE_KEY) { ytQueueCache.at = 0; try { pushStatus(); } catch (_) {} } });
  // YouTube single-page navigation finished: reset the advance guard and re-read its list.
  document.addEventListener('yt-navigate-finish', () => { ytQueueCache.at = 0; if (queueAdvancingFor !== getVideoId()) queueAdvancingFor = null; });

  function getStatus() {
    const v = videoEl();
    const p = player();
    let paused = true;
    let currentTime = 0;
    let duration = 0;
    let volume = lastKnownVolume;
    let muted = false;
    if (v) {
      paused = !!v.paused;
      currentTime = v.currentTime || 0;
      duration = v.duration && isFinite(v.duration) ? v.duration : 0;
      if (typeof v.volume === 'number' && isFinite(v.volume)) volume = v.volume;
      muted = !!v.muted;
    }
    if (p && typeof p.getPlayerState === 'function') {
      const st = p.getPlayerState();
      if (st === 1) paused = false;
      if (st === 2) paused = true;
    }
    if (p && typeof p.getCurrentTime === 'function') {
      try { currentTime = p.getCurrentTime() || currentTime; } catch (_) {}
    }
    if (p && typeof p.getDuration === 'function') {
      try {
        const d = p.getDuration();
        if (d && isFinite(d)) duration = d;
      } catch (_) {}
    }
    if (p && typeof p.isMuted === 'function') {
      try { muted = !!p.isMuted(); } catch (_) {}
    }
    ensureBassGraph();
    if (bassState.gain) {
      // Read the actual GainNode; do not lie with a cached lastKnownVolume while graph is live.
      volume = clamp01(bassState.gain.gain.value);
      lastKnownVolume = volume;
    } else if (p && typeof p.getVolume === 'function') {
      try {
        const raw = p.getVolume();
        if (typeof raw === 'number' && isFinite(raw)) {
          volume = Math.max(0, Math.min(1, raw / 100));
          lastKnownVolume = volume;
        }
      } catch (_) {}
    } else if (typeof volume === 'number' && isFinite(volume)) {
      lastKnownVolume = volume;
    }
    return {
      title: getTitle(),
      channel: getChannel(),
      videoId: getVideoId(),
      url: location.href,
      paused,
      currentTime,
      duration,
      volume,
      muted,
      bass: bassState.amount,
      bassDb: amountToDb(bassState.amount),
      bassHz: BASS_CONFIG.frequencyHz,
      bassMaxDb: BASS_CONFIG.maxCutDb,
      bassError: bassState.error,
      bassAttached: !!(bassState.source && bassState.attachedVideo),
      gain: bassState.gain ? bassState.gain.gain.value : null,
      stopAfter: !!stopAfter,
      ...queueStatus(),
    };
  }

  function clamp01(n) {
    n = Number(n);
    if (!isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
  }

  // Keep in sync with lib/bass.js BASS_DEFAULTS (no bundler; content script is standalone).
  const BASS_CONFIG = {
    frequencyHz: 200, // lowshelf corner; sensible desktop/headphone range ~150–250 Hz
    maxCutDb: 30,     // amount 0 → 0 dB (neutral); amount 1 → -maxCutDb
    defaultAmount: 0,
    q: 0.7,
  };

  const BASS_KEY = 'ytRemoteBassAmount';
  const bassState = {
    amount: BASS_CONFIG.defaultAmount,
    ctx: null,
    filter: null,
    gain: null,
    source: null,
    attachedVideo: null,
    error: null,
    // Persist MediaElementSource nodes per <video>; createMediaElementSource may only be called once per element.
    sources: (window.__ytRemoteBassSources = window.__ytRemoteBassSources || new WeakMap()),
  };
  try {
    const saved = sessionStorage.getItem(BASS_KEY);
    if (saved != null && saved !== '') {
      const n = Number(saved);
      if (isFinite(n)) bassState.amount = clamp01(n);
    }
  } catch (_) {}

  function amountToDb(amount) {
    const db = -BASS_CONFIG.maxCutDb * clamp01(amount);
    return Object.is(db, -0) ? 0 : db;
  }

  function clampAllVideoVolumes() {
    // Close the pre-wrap blast window: new YouTube <video> elements default to 1.0.
    try {
      document.querySelectorAll('video').forEach((el) => {
        try {
          if (typeof el.volume === 'number' && Math.abs(el.volume - lastKnownVolume) > 0.01) {
            el.volume = lastKnownVolume;
          }
        } catch (_) {}
      });
    } catch (_) {}
  }

  function ensureBassGraph() {
    clampAllVideoVolumes();
    const v = videoEl();
    if (!v) return false;
    try {
      if (!bassState.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        bassState.ctx = new AC();
        bassState.filter = bassState.ctx.createBiquadFilter();
        bassState.filter.type = 'lowshelf';
        bassState.filter.frequency.value = BASS_CONFIG.frequencyHz;
        bassState.filter.Q.value = BASS_CONFIG.q;
        bassState.filter.gain.value = amountToDb(bassState.amount);
        bassState.gain = bassState.ctx.createGain();
        bassState.gain.gain.value = lastKnownVolume;
        bassState.filter.connect(bassState.gain);
        bassState.gain.connect(bassState.ctx.destination);
      }
      if (!bassState.gain) {
        bassState.gain = bassState.ctx.createGain();
        bassState.gain.gain.value = lastKnownVolume;
        try { bassState.filter.disconnect(); } catch (_) {}
        bassState.filter.connect(bassState.gain);
        bassState.gain.connect(bassState.ctx.destination);
      }
      // Keep tunable filter settings + gain node as sole loudness authority while graph is active.
      if (bassState.filter) {
        bassState.filter.frequency.value = BASS_CONFIG.frequencyHz;
        bassState.filter.Q.value = BASS_CONFIG.q;
        bassState.filter.gain.value = amountToDb(bassState.amount);
      }
      bassState.gain.gain.value = lastKnownVolume;

      if (bassState.attachedVideo === v && bassState.source) {
        return true;
      }

      let source = bassState.sources.get(v);
      // Attenuate element before capture so default-route blasts are quieter if wrap lags.
      try { v.volume = lastKnownVolume; } catch (_) {}
      if (!source) {
        source = bassState.ctx.createMediaElementSource(v);
        bassState.sources.set(v, source);
      }
      try { if (bassState.source && bassState.source !== source) bassState.source.disconnect(); } catch (_) {}
      source.connect(bassState.filter);
      bassState.source = source;
      bassState.attachedVideo = v;
      // After MediaElementSource, element.volume no longer drives speakers reliably.
      // Drive loudness only through GainNode; leave element at 1 to avoid double attenuation confusion.
      try { v.volume = 1; } catch (_) {}
      bassState.gain.gain.value = lastKnownVolume;
      bassState.error = null;
      return true;
    } catch (e) {
      bassState.error = e && e.message ? e.message : String(e);
      return false;
    }
  }

  async function resumeBassContext() {
    ensureBassGraph();
    if (bassState.ctx && bassState.ctx.state === 'suspended') {
      try { await bassState.ctx.resume(); } catch (_) {}
    }
  }

  function setBass(amount) {
    bassState.amount = clamp01(amount);
    try { sessionStorage.setItem(BASS_KEY, String(bassState.amount)); } catch (_) {}
    ensureBassGraph();
    if (bassState.filter) bassState.filter.gain.value = amountToDb(bassState.amount);
    return resumeBassContext();
  }

  // Backup reattach / clamp (YouTube SPA / ads / quality swaps). Faster than relying on MutationObserver alone.
  setInterval(() => { try { ensureBassGraph(); } catch (_) {} }, 500);
  document.addEventListener('play', (ev) => {
    try {
      if (ev.target && (ev.target.tagName === 'VIDEO' || ev.target.tagName === 'AUDIO')) {
        clampAllVideoVolumes();
        ensureBassGraph();
        resumeBassContext();
        wireStopAfterHandlers();
        if (stopAfter) enforceStopAtEnd();
      }
    } catch (_) {}
  }, true);
  try {
    const mo = new MutationObserver(() => { try { clampAllVideoVolumes(); ensureBassGraph(); wireStopAfterHandlers(); } catch (_) {} });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  } catch (_) {}

  // Soft cleanup: suspend processing on tab hide; do not close the context (Premium/playback continuity).
  window.addEventListener('pagehide', () => {
    try {
      if (bassState.ctx && bassState.ctx.state === 'running') bassState.ctx.suspend();
    } catch (_) {}
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resumeBassContext();
  });

  function setVolume(vol) {
    vol = clamp01(vol);
    lastKnownVolume = vol;
    ensureBassGraph();
    if (bassState.gain) {
      try { bassState.gain.gain.value = vol; } catch (_) {}
      // Element volume left at 1 while graph controls loudness.
      const v = videoEl();
      if (v) {
        try { v.volume = 1; } catch (_) {}
        if (vol > 0 && v.muted) v.muted = false;
      }
      return;
    }
    const v = videoEl();
    const p = player();
    if (p && typeof p.setVolume === 'function') p.setVolume(Math.round(vol * 100));
    if (v) {
      v.volume = vol;
      if (vol > 0 && v.muted) v.muted = false;
    }
  }

  function seekTo(seconds) {
    seconds = Math.max(0, Number(seconds) || 0);
    const v = videoEl();
    const p = player();
    if (p && typeof p.seekTo === 'function') {
      p.seekTo(seconds, true);
      return;
    }
    if (v) v.currentTime = seconds;
  }

  async function handle(msg) {
    const action = msg.action;
    const v = videoEl();
    const p = player();

    if (['load','play','togglePlay','showYouTube'].includes(action)) {
      await chrome.runtime.sendMessage({ action: 'focusYouTube' });
    }
    if (['load','play','togglePlay'].includes(action)) {
      const cleanup = await chrome.runtime.sendMessage({action:'cleanupYouTube'});
      if (cleanup && cleanup.error) throw new Error(cleanup.error);
    }
    switch (action) {
      case 'reloadExtension':
        return await chrome.runtime.sendMessage({action:'reloadExtension'});
      case 'cleanupYouTube':
        return await chrome.runtime.sendMessage({action:'cleanupYouTube'});

      case 'showYouTube': return getStatus();
      case 'status':
        return getStatus();
      case 'togglePlay': {
        if (p && typeof p.getPlayerState === 'function') {
          const st = p.getPlayerState();
          if (st === 1 && typeof p.pauseVideo === 'function') p.pauseVideo();
          else if (typeof p.playVideo === 'function') p.playVideo();
        } else if (v) {
          if (v.paused) await v.play();
          else v.pause();
        }
        await resumeBassContext();
        return getStatus();
      }
      case 'play': {
        if (p && typeof p.playVideo === 'function') p.playVideo();
        else if (v) await v.play();
        await resumeBassContext();
        return getStatus();
      }
      case 'setBass': {
        await setBass(msg.amount);
        return getStatus();
      }
      case 'setStopAfter': {
        setStopAfter(!!msg.enabled || !!msg.on || !!msg.value);
        return getStatus();
      }
      case 'toggleStopAfter': {
        setStopAfter(!stopAfter);
        return getStatus();
      }
      case 'bassBy': {
        await setBass((bassState.amount || 0) + (Number(msg.delta) || 0));
        return getStatus();
      }
      case 'pause': {
        if (p && typeof p.pauseVideo === 'function') p.pauseVideo();
        else if (v) v.pause();
        return getStatus();
      }
      case 'seekBy': {
        const delta = Number(msg.seconds) || 0;
        const st = getStatus();
        seekTo((st.currentTime || 0) + delta);
        return getStatus();
      }
      case 'seekTo': {
        seekTo(msg.seconds);
        return getStatus();
      }
      case 'setVolume': {
        setVolume(msg.volume);
        return getStatus();
      }
      case 'volumeBy': {
        const st = getStatus();
        setVolume((st.volume || 0) + (Number(msg.delta) || 0));
        return getStatus();
      }
      case 'toggleMute': {
        if (p && typeof p.isMuted === 'function') {
          if (p.isMuted()) p.unMute();
          else p.mute();
        } else if (v) {
          v.muted = !v.muted;
        }
        return getStatus();
      }
      case 'mute': {
        if (p && typeof p.mute === 'function') p.mute();
        else if (v) v.muted = true;
        return getStatus();
      }
      case 'unmute': {
        if (p && typeof p.unMute === 'function') p.unMute();
        else if (v) v.muted = false;
        return getStatus();
      }
      case 'queueAdd':
      case 'queueRemove':
      case 'queueMove':
      case 'queueClear':
      case 'queuePlay':
      case 'ytQueuePlay':
        handleQueue(action, msg);
        return getStatus();
      case 'next': {
        // Your queue plays before YouTube's own next video.
        if (loadQueue().length) { playQueueItem(null); return getStatus(); }
        if (p && typeof p.nextVideo === 'function') p.nextVideo();
        else {
          const btn = document.querySelector('.ytp-next-button, .ytp-next-button.ytp-button');
          if (btn) btn.click();
        }
        return getStatus();
      }
      case 'load': {
        const url = msg.url || (msg.videoId ? ('https://www.youtube.com/watch?v=' + msg.videoId) : null);
        if (!url) throw new Error('url required');
        if (location.href !== url) location.href = url;
        return { ok: true, loading: url };
      }
      default:
        throw new Error('Unknown action: ' + action);
    }
  }

  function reply(id, result, error) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (error) socket.send(JSON.stringify({ id, error: String(error) }));
    else socket.send(JSON.stringify({ id, result }));
  }

  function pushStatus() {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify({ type: 'status', status: getStatus() }));
    } catch (_) {}
  }

  function connect() {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
    try {
      socket = new WebSocket(BRIDGE_URL);
    } catch (_) {
      scheduleReconnect();
      return;
    }

    socket.onopen = () => {
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (statusTimer) clearInterval(statusTimer);
      statusTimer = setInterval(pushStatus, 1500);
      pushStatus();
    };

    socket.onmessage = async (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id == null || !msg.action) return;
      try {
        const result = await handle(msg);
        if (result && (result.title !== undefined || result.currentTime !== undefined || result.paused !== undefined)) {
          reply(msg.id, { status: result });
        } else {
          reply(msg.id, { ...(result || { ok: true }), status: getStatus() });
        }
      } catch (e) {
        reply(msg.id, null, e.message || String(e));
      }
    };

    socket.onclose = () => {
      if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
      scheduleReconnect();
    };

    socket.onerror = () => {
      try { socket.close(); } catch (_) {}
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 1500);
  }

  // Also respond to extension messaging (background helper).
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      Promise.resolve()
        .then(() => handle(msg || {}))
        .then((result) => sendResponse(result))
        .catch((e) => sendResponse({ error: e.message || String(e) }));
      return true;
    });
  }

  wireStopAfterHandlers();
  connect();
})();
