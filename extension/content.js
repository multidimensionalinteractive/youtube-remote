(function () {
  if (window.__ytRemoteContentLoaded) return;
  window.__ytRemoteContentLoaded = true;

  // Default matches server port 8790. If you change YT_REMOTE_PORT, update this URL and extension/manifest.json host_permissions.
  const BRIDGE_URL = 'ws://127.0.0.1:8790/?role=bridge';
  let socket = null;
  let reconnectTimer = null;
  let statusTimer = null;

  // Desired loudness (0–1). While the Web Audio graph is active, GainNode is the authority —
  // element/player volume reads after createMediaElementSource are not trustworthy.
  let lastKnownVolume = 0.75;

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
      // Read the actual GainNode — do not lie with a cached lastKnownVolume while graph is live.
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
    // Persist MediaElementSource nodes per <video> — createMediaElementSource may only be called once per element.
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
      }
    } catch (_) {}
  }, true);
  try {
    const mo = new MutationObserver(() => { try { clampAllVideoVolumes(); ensureBassGraph(); } catch (_) {} });
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
      case 'next': {
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

  connect();
})();
